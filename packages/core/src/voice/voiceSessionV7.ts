/**
 * Voice session v7 (v1.08, Đội T5 — voice realtime v7).
 *
 * Composition, not a rewrite: one `VoiceSessionV6` (v1.07 — the
 * durable long call: checkpoints + resume + media + barge-in v3/v4
 * + latency pipeline + turn history + explicit call state +
 * mid-call voice switching + network guard) plus the three v1.08
 * pieces around it:
 *
 *   - `AdaptiveVadV7` — energy + ZCR joint detection, presets,
 *     per-window confidence, false-positive classification. The
 *     session feeds every mic frame to it; its speech-start /
 *     speech-end events drive the transcript phase and the
 *     barge-in's VAD input.
 *   - `BargeInV7Controller` — graded interruption (duck vs
 *     interrupt), grace + echo windows, cooldown, word-level
 *     partials with an exact cut word. The session feeds it the
 *     same frames (with the VAD's confidence); on `interrupt` it
 *     cancels the TTS through the v6 session and keeps the
 *     partial; on `duck` it records the duck.
 *   - `TranscriptStreamV7` — word-by-word transcript with
 *     speakers (user / agent), interim vs final, phase
 *     (listening / thinking / speaking) and token estimates. The
 *     panel reads it live; the tools read it on demand.
 *
 * Events: every `VoiceSessionV6` event is forwarded unchanged,
 * plus v7 kinds (`v7-vad`, `v7-barge-in`, `v7-duck`,
 * `v7-transcript`, `v7-phase`, `v7-interrupted`). All live paths
 * stay mock unless the caller passes a live transport factory —
 * v7 never dials anything itself.
 * `createMockVoiceSessionV7()` is the mock factory the session
 * manager and the tools use. `simulateTurn()` drives a scripted
 * mock turn (user line → thinking → agent words streaming in)
 * so the panel and the tests can watch a call without a provider.
 */
import type { RealtimeConfig } from './types';
import { isValidPcm16Frame, pcm16Rms } from './audio';
import {
  VoiceSessionV6,
  type VoiceSessionV6Event,
  type VoiceSessionV6Options,
  type VoiceSessionV6Stats,
} from './voiceSessionV6';
import {
  AdaptiveVadV7,
  type AdaptiveVadV7Options,
  type VadV7Config,
  type VadV7Event,
  type VadV7PresetName,
  type VadV7Stats,
} from './vadV7';
import {
  BargeInV7Controller,
  buildResumeUtteranceV7,
  splitWords,
  type BargeInV7Controller as BargeInV7ControllerType,
  type BargeInV7Decision,
  type BargeInV7DuckResult,
  type BargeInV7InterruptResult,
  type BargeInV7Options,
  type BargeInV7PartialUtterance,
  type BargeInV7Stats,
} from './bargeInV7';
import {
  TranscriptStreamV7,
  type TranscriptV7Event,
  type TranscriptV7Line,
  type TranscriptV7Phase,
  type TranscriptV7Speaker,
  type TranscriptV7Stats,
} from './transcriptStreamV7';
import type { VoiceCallState } from './voiceStateMachine';
import type { VoiceProfile } from './voiceProfiles';
import { MockRealtimeTransport } from './mockTransport';
import { VoiceSwitchManager } from './voiceSwitch';

/** Extra events the v7 wrapper emits (on top of the v6 events). */
export type VoiceSessionV7Event =
  | VoiceSessionV6Event
  | VadV7Event
  | TranscriptV7Event
  | { kind: 'v7-barge-in'; decision: BargeInV7Decision; result: BargeInV7InterruptResult }
  | { kind: 'v7-duck'; result: BargeInV7DuckResult }
  | { kind: 'v7-interrupted'; partialText: string; cutWordIndex: number; at: number };

export type VoiceSessionV7EventSink = (event: VoiceSessionV7Event) => void;

/** Stats for the panel / diagnostics / tools. */
export interface VoiceSessionV7Stats {
  callState: VoiceCallState;
  phase: TranscriptV7Phase;
  startedAtMs: number | null;
  /** ms since connect (0 when never connected). */
  durationMs: number;
  vad: VadV7Stats;
  bargeIn: BargeInV7Stats;
  transcript: TranscriptV7Stats;
  v6: VoiceSessionV6Stats;
}

/** One row for the session panel (list of sessions). */
export interface VoiceSessionV7Summary {
  id: string;
  callState: VoiceCallState;
  phase: TranscriptV7Phase;
  provider: string;
  voiceId: string | null;
  voiceName: string | null;
  connected: boolean;
  startedAtMs: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  lines: number;
  interrupts: number;
  ducks: number;
  restoredFrom: boolean;
}

export interface VoiceSessionV7Options {
  /** Options for the inner `VoiceSessionV6`. */
  v6: VoiceSessionV6Options;
  /** VAD v7 options. */
  vad?: AdaptiveVadV7Options;
  /** Barge-in v7 options. */
  bargeIn?: BargeInV7Options;
  /** ms between streamed mock-reply words (simulateTurn). Default 40. */
  mockWordDelayMs?: number;
  /** Sleep used by simulateTurn (tests inject a no-op). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (v6 events + v7 events). */
  onEvent?: VoiceSessionV7EventSink;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Default mock reply (scripted) when simulateTurn gets no reply text. */
export const VOICE_V7_DEFAULT_MOCK_REPLY =
  'Hello, this is a mock voice reply from the v7 session. The transcript streams word by word so the panel can show it live.';

export class VoiceSessionV7 {
  private readonly v6: VoiceSessionV6;
  private readonly vad: AdaptiveVadV7;
  private readonly bargeIn: BargeInV7Controller;
  private readonly transcript: TranscriptStreamV7;
  private readonly onEvent: VoiceSessionV7EventSink | undefined;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly mockWordDelayMs: number;
  private startedAtMs: number | null = null;
  private simulating = false;
  /** Snapshot this session was restored from (null when fresh). */
  private restoredFrom: unknown = null;

  constructor(options: VoiceSessionV7Options) {
    this.clock = options.clock ?? Date.now;
    this.sleepFn = options.sleepMs ?? sleep;
    this.mockWordDelayMs = Math.max(0, options.mockWordDelayMs ?? 40);
    this.onEvent = options.onEvent;
    this.transcript = new TranscriptStreamV7({
      clock: this.clock,
      onEvent: (e) => this.emit(e),
    });
    this.vad = new AdaptiveVadV7({
      ...(options.vad ?? {}),
      sink: (e) => {
        this.emit(e);
        if (e.kind === 'speech-start') this.transcript.setPhase('listening');
      },
    });
    this.bargeIn = new BargeInV7Controller({
      ...(options.bargeIn ?? {}),
      clock: this.clock,
    });
    this.v6 = new VoiceSessionV6({
      ...options.v6,
      clock: this.clock,
      onEvent: (e) => this.handleV6Event(e),
    });
  }

  // -- passthroughs -------------------------------------------------------

  getCallState(): VoiceCallState {
    return this.v6.getCallState();
  }

  /** The transcript phase (listening / thinking / speaking / idle). */
  getPhase(): TranscriptV7Phase {
    return this.transcript.getPhase();
  }

  isConnected(): boolean {
    return this.v6.isConnected();
  }

  getSessionId(): string {
    return this.v6.getSessionId();
  }

  getProvider(): string {
    return this.v6.getProvider();
  }

  getTurnCount(): number {
    return this.v6.getTurnCount();
  }

  getBargeInCount(): number {
    return this.v6.getBargeInCount();
  }

  getCurrentVoiceId(): string | null {
    return this.v6.getCurrentVoiceId();
  }

  getCurrentVoice(): VoiceProfile | null {
    return this.v6.getCurrentVoice();
  }

  listVoices(): VoiceProfile[] {
    return this.v6.listVoices();
  }

  switchVoice(profileId: string, reason = 'user pick'): ReturnType<VoiceSessionV6['switchVoice']> {
    return this.v6.switchVoice(profileId, reason);
  }

  revertVoice(): ReturnType<VoiceSessionV6['revertVoice']> {
    return this.v6.revertVoice();
  }

  /** Hand the v6 wrapper through (checkpoints, resume, media, latency). */
  getV6(): VoiceSessionV6 {
    return this.v6;
  }

  getVad(): AdaptiveVadV7 {
    return this.vad;
  }

  getBargeIn(): BargeInV7ControllerType {
    return this.bargeIn;
  }

  getTranscriptStream(): TranscriptStreamV7 {
    return this.transcript;
  }

  /** Snapshot this session was restored from (null when fresh). */
  getRestoredSnapshot(): unknown {
    return this.restoredFrom;
  }

  /** Attach the snapshot this session was restored from (store use). */
  attachRestoredSnapshot(snapshot: unknown): void {
    this.restoredFrom = snapshot;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Open the call (mock unless the v6 options carry a live transport). */
  async connect(config: RealtimeConfig): Promise<void> {
    await this.v6.connect(config);
    if (this.startedAtMs === null) this.startedAtMs = this.clock();
    this.transcript.setPhase('listening');
  }

  /** Reconnect a dropped call with the last config (through the v6 guard). */
  reconnect(): Promise<{ ok: boolean; attempts: number; error?: string }> {
    return this.v6.reconnect();
  }

  /** Hang up: the transcript phase ends, then the session dies. */
  disconnect(): void {
    this.transcript.setPhase('idle');
    this.vad.flush();
    this.v6.disconnect();
  }

  dispose(): void {
    this.disconnect();
    this.v6.dispose();
  }

  // -- audio in (mic frames) --------------------------------------------------

  /**
   * One mic frame (PCM16). Feeds the VAD v7 (speech detection +
   * confidence) and the barge-in v7 controller (duck / interrupt
   * while the model speaks). A confirmed interrupt cancels the
   * TTS through the v6 session, marks the open agent line
   * interrupted, and keeps the partial for resume. Returns the
   * barge-in decision (null when the model is not speaking).
   */
  async feedAudioFrame(frame: Uint8Array): Promise<BargeInV7Decision | null> {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('VoiceSessionV7: frame must be a non-empty even-length PCM16 buffer.');
    }
    this.vad.feed(frame);
    const rms = pcm16Rms(frame);
    const vadActive = this.vad.isSpeaking();
    const confidence = this.vad.confidence;
    if (!this.bargeIn.isModelSpeaking()) return null;
    const decision = this.bargeIn.noteAudioFrame({ rms, vadActive, confidence });
    if (decision.action === 'duck') {
      const result = this.bargeIn.duck(rms);
      this.emit({ kind: 'v7-duck', result });
      return decision;
    }
    if (decision.action === 'interrupt') {
      const result = await this.interrupt();
      this.emit({ kind: 'v7-barge-in', decision, result });
      return decision;
    }
    return decision;
  }

  // -- transcript in ----------------------------------------------------------

  /**
   * Note user speech (STT result or scripted mock line). A final
   * line means the user finished — the phase moves to `thinking`
   * (the model is generating). An interim line keeps `listening`.
   */
  noteUserText(text: string, options: { final?: boolean; confidence?: number } = {}): TranscriptV7Line {
    const line = this.transcript.appendText('user', text, {
      final: options.final ?? false,
      confidence: options.confidence ?? 1,
    });
    this.transcript.setPhase(options.final === true ? 'thinking' : 'listening');
    return line;
  }

  /**
   * Note model speech (TTS words or scripted mock line). Streams
   * into the open agent line and moves the phase to `speaking`;
   * a final line moves it back to `listening`. Also feeds the
   * barge-in's word tracking so an interrupt keeps the cut word.
   */
  noteModelText(text: string, options: { final?: boolean; confidence?: number } = {}): TranscriptV7Line {
    const words = splitWords(text);
    if (words.length > 0) this.bargeIn.noteModelWords(words);
    this.bargeIn.noteModelText(text);
    const line = this.transcript.appendText('agent', text, {
      final: options.final ?? false,
      confidence: options.confidence ?? 1,
    });
    this.transcript.setPhase(options.final === true ? 'listening' : 'speaking');
    return line;
  }

  // -- barge-in out -----------------------------------------------------------

  /**
   * Cancel the TTS now (the v7 interrupt): the v6 session stops
   * the playback, the open agent line is marked interrupted, the
   * partial (with the cut word) is kept for resume. Returns the
   * v7 interrupt result.
   */
  async interrupt(): Promise<BargeInV7InterruptResult> {
    const result = await this.bargeIn.interrupt(async () => {
      await this.v6.interruptV4();
    });
    this.transcript.interruptLine('agent');
    this.transcript.setPhase('listening');
    this.emit({ kind: 'v7-interrupted', partialText: result.partialText, cutWordIndex: result.cutWordIndex, at: this.clock() });
    return result;
  }

  /** Resume the cut reply (the v7 partial + resume prompt). */
  resumePartial(): { partial: BargeInV7PartialUtterance; resumePrompt: string } | null {
    const resumed = this.bargeIn.resumePartial();
    if (!resumed) return null;
    this.transcript.setPhase('speaking');
    return resumed;
  }

  /**
   * Duck the TTS briefly (quieter, not stopped) — the v7 duck.
   * The tools call this (`voice_v7_barge_in` action=duck); the
   * volume drop itself is the caller's job, the controller owns
   * the timing (duck expires back to `listening` on its own).
   */
  duck(rms: number): BargeInV7DuckResult {
    const result = this.bargeIn.duck(rms);
    this.emit({ kind: 'v7-duck', result });
    return result;
  }

  /** The resume prompt for the last cut reply ('' when nothing was cut). */
  getResumePrompt(): string {
    const partial = this.bargeIn.getPartials()[this.bargeIn.getPartials().length - 1];
    if (!partial) return '';
    return buildResumeUtteranceV7(partial);
  }

  // -- mock turns (panel demo + tests) ----------------------------------------

  /**
   * Drive one scripted mock turn: the user line finalizes, the
   * phase goes `thinking`, then the agent reply streams word by
   * word (one interim update per word) and finalizes, and the
   * phase returns to `listening`. No provider, no network — the
   * mock transport's canned reply is never used here; the caller
   * supplies the reply (or the default mock reply). While a turn
   * is simulating, a second call is refused (returns false).
   */
  async simulateTurn(
    userText: string,
    modelReply: string = VOICE_V7_DEFAULT_MOCK_REPLY,
  ): Promise<boolean> {
    if (this.simulating) return false;
    this.simulating = true;
    try {
      this.noteUserText(userText, { final: true });
      this.transcript.setPhase('thinking');
      await this.sleepFn(this.mockWordDelayMs);
      // The model starts speaking: barge-in watches from here.
      this.bargeIn.modelSpeechStarted();
      this.bargeIn.notePlannedReply(modelReply);
      const words = splitWords(modelReply);
      for (const word of words) {
        // A barge-in during the stream stops the reply mid-word:
        // the loop sees the interrupted state and stops streaming.
        if (this.bargeIn.getState() === 'interrupted' || this.bargeIn.getState() === 'cooldown') break;
        this.noteModelText(word, { final: false });
        await this.sleepFn(this.mockWordDelayMs);
      }
      if (this.bargeIn.getState() === 'listening' || this.bargeIn.getState() === 'ducked') {
        this.transcript.finalizeLine();
        this.bargeIn.modelSpeechEnded();
        this.transcript.setPhase('listening');
      }
      return true;
    } finally {
      this.simulating = false;
    }
  }

  /** True while a scripted mock turn is streaming. */
  isSimulating(): boolean {
    return this.simulating;
  }

  // -- VAD config -------------------------------------------------------------

  /** Switch the VAD to a named preset (live). */
  setVadPreset(preset: VadV7PresetName): VadV7Config {
    return this.vad.setPreset(preset);
  }

  /** Reconfigure the VAD live (preset + overrides). */
  updateVadOptions(patch: Parameters<AdaptiveVadV7['updateOptions']>[0]): VadV7Config {
    return this.vad.updateOptions(patch);
  }

  /** Learn the room's noise floor fast (calibration). */
  calibrateVad(durationMs?: number): void {
    this.vad.startCalibration(durationMs);
  }

  // -- stats ------------------------------------------------------------------

  getV7Stats(): VoiceSessionV7Stats {
    const transcriptStats = this.transcript.getStats();
    const now = this.clock();
    return {
      callState: this.v6.getCallState(),
      phase: transcriptStats.phase,
      startedAtMs: this.startedAtMs,
      durationMs: this.startedAtMs === null ? 0 : Math.max(0, now - this.startedAtMs),
      vad: this.vad.getStats(),
      bargeIn: this.bargeIn.getStats(),
      transcript: transcriptStats,
      v6: this.v6.getV6Stats(),
    };
  }

  getSummary(): VoiceSessionV7Summary {
    const stats = this.getV7Stats();
    const current = this.v6.getCurrentVoice();
    return {
      id: '',
      callState: stats.callState,
      phase: stats.phase,
      provider: this.v6.getProvider(),
      voiceId: stats.v6.voice.currentId,
      voiceName: current?.name ?? stats.v6.voice.currentName,
      connected: this.isConnected(),
      startedAtMs: stats.startedAtMs,
      durationMs: stats.durationMs,
      inputTokens: stats.transcript.inputTokens,
      outputTokens: stats.transcript.outputTokens,
      lines: stats.transcript.lines,
      interrupts: stats.bargeIn.interrupts,
      ducks: stats.bargeIn.ducks,
      restoredFrom: this.restoredFrom !== null,
    };
  }

  /** One-line summary for the panel / session log. */
  summary(): string {
    const stats = this.getV7Stats();
    return (
      `v7 call=${stats.callState} phase=${stats.phase} ` +
      `vad=${stats.vad.preset} (thr ${stats.vad.threshold.toFixed(3)}, fp ${stats.vad.falsePositives}) ` +
      `barge-in=${stats.bargeIn.interrupts} int / ${stats.bargeIn.ducks} duck ` +
      `transcript=${stats.transcript.lines} lines (${stats.transcript.inputTokens}+${stats.transcript.outputTokens} tok)`
    );
  }

  // -- internals ------------------------------------------------------------

  private handleV6Event(event: VoiceSessionV6Event): void {
    // The model started speaking (audio event) — the barge-in
    // controller watches from here (grace + echo windows start).
    if (event.kind === 'audio') {
      if (!this.bargeIn.isModelSpeaking()) this.bargeIn.modelSpeechStarted();
      this.transcript.setPhase('speaking');
    }
    if (event.kind === 'turn' && event.speaker === 'model') {
      this.transcript.setPhase('listening');
    }
    this.emit(event);
  }

  private emit(event: VoiceSessionV7Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** Session id pattern (same shape as the v6 manager). */
export const VOICE_V7_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default mock reply delay (ms) for mock v7 sessions. */
export const VOICE_V7_MOCK_REPLY_DELAY_MS = 10;

export function createMockVoiceSessionV7(
  options: {
    sessionId?: string;
    provider?: 'openai' | 'gemini' | 'openai-compatible';
    initialVoiceId?: string;
    voices?: readonly VoiceProfile[];
    vadPreset?: VadV7PresetName;
    clock?: () => number;
    onEvent?: VoiceSessionV7EventSink;
    replyDelayMs?: number;
    mockWordDelayMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
  } = {},
): VoiceSessionV7 {
  const provider = options.provider ?? 'openai';
  void options.sessionId;
  return new VoiceSessionV7({
    v6: {
      v4: {
        v3: {
          v2: {
            session: {
              provider,
              transportFactory: (cb) =>
                new MockRealtimeTransport(cb, { replyDelayMs: options.replyDelayMs ?? VOICE_V7_MOCK_REPLY_DELAY_MS }, provider),
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
    vad: { preset: options.vadPreset ?? 'office' },
    clock: options.clock,
    mockWordDelayMs: options.mockWordDelayMs,
    sleepMs: options.sleepMs,
    onEvent: options.onEvent,
  });
}

/**
 * In-memory registry the tools bind to: creates mock v7 sessions,
 * holds them by id, lists / removes them, and reports totals.
 * Everything is local: sessions run on mock transports unless the
 * host wires a live one; no key is ever read here.
 */
export class VoiceV7Manager {
  private readonly sessions = new Map<string, VoiceSessionV7>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  createSession(
    id: string,
    options: {
      provider?: 'openai' | 'gemini' | 'openai-compatible';
      initialVoiceId?: string;
      vadPreset?: VadV7PresetName;
    } = {},
  ): VoiceSessionV7 {
    const cleanId = String(id ?? '').trim();
    if (!VOICE_V7_SESSION_ID_RE.test(cleanId)) {
      throw new Error(`Invalid voice v7 session id "${id}".`);
    }
    if (this.sessions.has(cleanId)) {
      throw new Error(`Voice v7 session "${cleanId}" already exists.`);
    }
    const session = createMockVoiceSessionV7({
      provider: options.provider,
      initialVoiceId: options.initialVoiceId,
      vadPreset: options.vadPreset,
      clock: this.clock,
    });
    this.sessions.set(cleanId, session);
    return session;
  }

  getSession(id: string): VoiceSessionV7 | undefined {
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

  listSessions(): VoiceSessionV7Summary[] {
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
    interrupts: number;
    ducks: number;
    inputTokens: number;
    outputTokens: number;
    lines: number;
  } {
    let live = 0;
    let interrupts = 0;
    let ducks = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lines = 0;
    for (const session of this.sessions.values()) {
      if (session.isConnected()) live += 1;
      const stats = session.getV7Stats();
      interrupts += stats.bargeIn.interrupts;
      ducks += stats.bargeIn.ducks;
      inputTokens += stats.transcript.inputTokens;
      outputTokens += stats.transcript.outputTokens;
      lines += stats.transcript.lines;
    }
    return { sessions: this.sessions.size, live, interrupts, ducks, inputTokens, outputTokens, lines };
  }
}
