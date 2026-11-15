/**
 * Realtime voice pipeline v2 (v1.11, Đội T5 — voice realtime v2).
 *
 * v9 tied VAD + barge-in + transcript together for one call, but the
 * transport was all-or-nothing: when the realtime socket dropped,
 * the call died. v2 keeps the same four-state call
 * (listening → processing → speaking → listening) and adds the
 * three things a real call needs to survive:
 *
 * 1. Streaming partials with stability. The recogniser re-emits the
 *    whole hypothesis ("xin", "xin chào", "xin chào bạn"); v2 keeps
 *    the latest interim, counts how many times the same text repeats
 *    (stability), and only commits it into the transcript when it is
 *    stable or the turn ends. The UI renders the interim live with
 *    its stability, so a flickering hypothesis never looks like a
 *    final answer. First-partial latency (session start → first
 *    partial) and turn latency (speech-end → first agent audio) are
 *    measured on the virtual clock and reported in stats.
 * 2. Better turn-taking. A grace period after the agent stops
 *    speaking keeps the mic closed briefly (the echo tail of the
 *    agent's last words must not become a phantom user turn), and a
 *    barge-in during `processing` cancels the pending reply before
 *    any audio is queued. The barge-in decision itself is delegated
 *    to `BargeInV9Controller` (immediate / grace / confirm policies),
 *    so v2 inherits its cooldown, echo guard and exact cut receipt.
 * 3. Fallback to batch. The transport is injected (`RealtimeV2Transport`)
 *    — a live WebSocket adapter in production, a scripted mock here.
 *    When the transport errors or closes unexpectedly, the pipeline
 *    does not die: it switches to `batch` mode (user audio is queued
 *    and "transcribed" by the injected batch STT, the reply streams
 *    through the injected batch TTS), keeps the transcript and the
 *    turn state, and retries realtime after a cooldown (up to
 *    `maxRecoverAttempts`). Every switch is an event with a reason,
 *    so the UI can say "realtime mất, đang dùng batch" instead of
 *    showing a spinner forever.
 *
 * Determinism: the pipeline owns a virtual clock (`nowMs`, starts at
 * 0). `feedAudio()` advances it 20 ms per frame; `tick()` advances it
 * manually; the mock transport and the mock model are scripts driven
 * by that clock. Nothing here touches a sound card, a network socket
 * or a key — the mock model is a script of reply strings and the
 * batch STT/TTS are injected fakes the tests supply.
 *
 * Audio path per frame: mic frame → noise suppressor → VAD v10.
 * Silence frames also teach the suppressor's noise profile. The
 * suppressor is bypassed (`level: 'off'`) when the caller wants raw
 * audio (tests, quiet rooms).
 */

import { isValidPcm16Frame } from './audio';
import { VadV10, VAD_V10_FRAME_MS, VAD_V10_FRAME_SAMPLES, type VadV10Options, type VadV10Stats } from './vadV10';
import { NoiseSuppressorV10, type NoiseSuppressionV10Options, type NoiseSuppressionV10Stats } from './noiseSuppressionV10';
import { BargeInV9Controller, splitWordsV9, type BargeInV9Options, type BargeInV9InterruptResult, type BargeInV9Stats } from './bargeInV9';
import { TranscriptStreamV9, transcriptV9Markdown, type TranscriptV9Options, type TranscriptV9Stats } from './transcriptStreamV9';

/** Pipeline mode: live realtime transport, or batch STT/TTS. */
export type RealtimeV2Mode = 'realtime' | 'batch';
/** Pipeline state (what the panel renders). */
export type RealtimeV2State = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'degraded' | 'closed';
/** Why the pipeline fell back to batch (or failed outright). */
export type RealtimeV2FallbackReason =
  | 'transport-error'
  | 'transport-closed'
  | 'dial-timeout'
  | 'no-key'
  | 'manual';

/** Session id pattern (same shape as the v9 manager). */
export const REALTIME_V2_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default scripted mock reply (says plainly this is mock mode). */
export const REALTIME_V2_DEFAULT_MOCK_REPLY =
  'Hello — this is mock realtime v2 mode. Add an API key in Settings to talk to a live model.';

/** A message the transport delivers to the pipeline. */
export type RealtimeV2TransportMessage =
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'audio'; pcm16Base64: string }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; code: number; reason: string };

export type RealtimeV2TransportSink = (message: RealtimeV2TransportMessage) => void;

/** What a realtime transport must do (live adapter or mock). */
export interface RealtimeV2Transport {
  /** Human-readable provider name (for stats / the panel). */
  readonly provider: string;
  /** True once `connect()` resolved. */
  readonly connected: boolean;
  /** Open the transport; resolves when the session is live. */
  connect(): Promise<void>;
  /** Close the transport (intentional — no reconnect). */
  disconnect(): void;
  /** Send one mic frame (base64 PCM16) upstream. */
  sendAudio(pcm16Base64: string): void;
  /** Deliver one scripted server reply (mock transports only). */
  injectServerReply?(reply: string): void;
  /** Subscribe to server messages. */
  onMessage(sink: RealtimeV2TransportSink): void;
}

/** Batch STT: turn queued audio into text (injected fake in tests). */
export type RealtimeV2BatchStt = (frames: Uint8Array[], input: { language?: string }) => Promise<string>;
/** Batch TTS: turn text into spoken words (injected fake in tests). */
export type RealtimeV2BatchTts = (text: string, input: { voice?: string; rate?: number }) => Promise<string[]>;

/** Options for creating a `RealtimeVoicePipelineV2`. */
export interface RealtimeV2Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  vad?: VadV10Options;
  noise?: NoiseSuppressionV10Options;
  bargeIn?: BargeInV9Options;
  transcript?: TranscriptV9Options;
  /** Scripted mock replies, in order (last repeats). */
  mockReplies?: string[];
  /** Per-word streaming pace of the mock reply (ms, virtual clock). */
  mockWordMs?: number;
  /** Grace after the agent stops before the mic reopens (ms). */
  micReopenGraceMs?: number;
  /** Consecutive identical partials that mark a hypothesis stable. */
  partialStabilityRepeats?: number;
  /** Cooldown before a realtime retry after a fallback (ms). */
  recoverCooldownMs?: number;
  /** Max realtime retries after fallbacks (0 = never retry). */
  maxRecoverAttempts?: number;
  /** Transport factory (default: scripted mock transport). */
  createTransport?: () => RealtimeV2Transport;
  /** Batch STT used in batch mode (default: scripted fake). */
  batchStt?: RealtimeV2BatchStt;
  /** Batch TTS used in batch mode (default: splits the reply into words). */
  batchTts?: RealtimeV2BatchTts;
  /** Host-injected tool runner (default: refuses — no tools bound). */
  toolHandler?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result: string }>;
}

/** Events emitted by a v2 pipeline. */
export type RealtimeV2Event =
  | { kind: 'state'; state: RealtimeV2State; atMs: number }
  | { kind: 'mode'; mode: RealtimeV2Mode; reason: RealtimeV2FallbackReason | 'recovered' | 'started'; atMs: number }
  | { kind: 'partial'; atMs: number; speakerId: string; text: string; stable: boolean; latencyMs: number | null }
  | { kind: 'final'; atMs: number; speakerId: string; text: string }
  | { kind: 'speech-start'; atMs: number }
  | { kind: 'speech-end'; atMs: number; durationMs: number }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'barge-in'; atMs: number; result: BargeInV9InterruptResult }
  | { kind: 'duck'; atMs: number; factor: number }
  | { kind: 'resume'; atMs: number }
  | { kind: 'audio-level'; atMs: number; level: number }
  | { kind: 'fallback'; atMs: number; reason: RealtimeV2FallbackReason; detail: string }
  | { kind: 'recovered'; atMs: number; attempt: number }
  | { kind: 'error'; atMs: number; message: string };

export type RealtimeV2EventSink = (event: RealtimeV2Event) => void;

/** Counters for one pipeline. */
export interface RealtimeV2Stats {
  state: RealtimeV2State;
  mode: RealtimeV2Mode;
  turns: number;
  userTurns: number;
  agentTurns: number;
  partials: number;
  stablePartials: number;
  fallbacks: number;
  recoveries: number;
  recoverAttempts: number;
  interrupts: number;
  ducks: number;
  connectedMs: number;
  /** ms from connect to the first partial (null = none yet). */
  firstPartialLatencyMs: number | null;
  /** ms from speech-end to the first agent audio (null = none yet). */
  turnLatencyMs: number | null;
  /** Mean turn latency over completed turns (null = none yet). */
  meanTurnLatencyMs: number | null;
  vad: VadV10Stats;
  noise: NoiseSuppressionV10Stats;
  bargeIn: BargeInV9Stats;
  transcript: TranscriptV9Stats;
}

/**
 * Streaming partial buffer: the recogniser re-emits the whole
 * hypothesis each time, so the buffer keeps the latest text, counts
 * repeats (stability), and reports the latency of the first partial
 * of each turn. Pure data, no audio.
 */
export class PartialTranscriptBufferV2 {
  private text = '';
  private repeats = 0;
  private firstAtMs: number | null = null;
  private partials = 0;
  private stablePartials = 0;
  private readonly stabilityRepeats: number;

  constructor(stabilityRepeats = 2) {
    if (!Number.isInteger(stabilityRepeats) || stabilityRepeats < 1 || stabilityRepeats > 10) {
      throw new Error('Partial stability repeats must be an integer in 1..10.');
    }
    this.stabilityRepeats = stabilityRepeats;
  }

  getText(): string {
    return this.text;
  }

  isStable(): boolean {
    return this.repeats >= this.stabilityRepeats;
  }

  getCounts(): { partials: number; stablePartials: number } {
    return { partials: this.partials, stablePartials: this.stablePartials };
  }

  /** Push a new hypothesis. Returns the stored text + stability. */
  push(text: string, atMs: number): { text: string; stable: boolean; latencyMs: number | null } {
    if (typeof text !== 'string') throw new Error('Partial text must be a string.');
    const capped = text.slice(0, 4000);
    if (this.firstAtMs === null) this.firstAtMs = atMs;
    if (capped === this.text) {
      this.repeats += 1;
    } else {
      this.text = capped;
      this.repeats = 1;
    }
    this.partials += 1;
    const stable = this.isStable();
    if (stable) this.stablePartials += 1;
    return { text: this.text, stable, latencyMs: atMs - this.firstAtMs };
  }

  /** Clear the buffer at a turn boundary; returns the text kept. */
  clear(): string {
    const kept = this.text;
    this.text = '';
    this.repeats = 0;
    this.firstAtMs = null;
    return kept;
  }
}

/**
 * Scripted mock transport: no socket, no key. `connect()` resolves
 * at once; `injectServerReply()` delivers a scripted partial stream
 * (growing prefixes) followed by a final, synchronously, so tests
 * can drive the whole realtime path without timers.
 */
export class MockRealtimeV2Transport implements RealtimeV2Transport {
  readonly provider = 'mock';
  connected = false;
  private sink: RealtimeV2TransportSink | null = null;
  private sentFrames = 0;
  /** Fail the next connect() with this error (test hook). */
  failNextConnectWith: Error | null = null;
  /** Close the transport on the next sendAudio() (test hook). */
  failNextSendWith: { code: number; reason: string } | null = null;

  onMessage(sink: RealtimeV2TransportSink): void {
    this.sink = sink;
  }

  async connect(): Promise<void> {
    if (this.failNextConnectWith) {
      const error = this.failNextConnectWith;
      this.failNextConnectWith = null;
      throw error;
    }
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  sendAudio(_pcm16Base64: string): void {
    if (!this.connected) throw new Error('Mock realtime transport is not connected.');
    if (this.failNextSendWith) {
      const failure = this.failNextSendWith;
      this.failNextSendWith = null;
      this.connected = false;
      this.sink?.({ kind: 'closed', code: failure.code, reason: failure.reason });
      return;
    }
    this.sentFrames += 1;
  }

  injectServerReply(reply: string): void {
    if (!this.connected || !this.sink) return;
    const words = reply.split(/\s+/).filter(Boolean);
    let hypothesis = '';
    for (const word of words) {
      hypothesis = hypothesis ? `${hypothesis} ${word}` : word;
      this.sink({ kind: 'partial', text: hypothesis });
    }
    this.sink({ kind: 'final', text: reply });
  }

  getSentFrames(): number {
    return this.sentFrames;
  }
}

function toBase64(frame: Uint8Array): string {
  return Buffer.from(frame).toString('base64');
}

function defaultBatchStt(frames: Uint8Array[], _input: { language?: string }): Promise<string> {
  // The default fake transcribes queued audio as a fixed sentence so
  // batch mode is observable without a model; hosts replace it.
  void frames;
  return Promise.resolve('[batch transcript: audio queued while realtime was down]');
}

function defaultBatchTts(text: string, _input: { voice?: string; rate?: number }): Promise<string[]> {
  return Promise.resolve(text.split(/\s+/).filter(Boolean));
}

/**
 * Realtime voice pipeline v2: VAD v10 + noise suppression +
 * barge-in v9 + streaming partials + batch fallback, around the
 * four-state call machine. Deterministic virtual clock; mock
 * transport by default.
 */
export class RealtimeVoicePipelineV2 {
  private readonly sessionId: string;
  private readonly botId: string;
  private readonly language: string;
  private readonly voice: string;
  private readonly vad: VadV10;
  private readonly noise: NoiseSuppressorV10;
  private readonly bargeIn: BargeInV9Controller;
  private readonly transcript: TranscriptStreamV9;
  private readonly partials: PartialTranscriptBufferV2;
  private readonly sink: RealtimeV2EventSink | null;
  private readonly mockReplies: string[];
  private readonly mockWordMs: number;
  private readonly micReopenGraceMs: number;
  private readonly recoverCooldownMs: number;
  private readonly maxRecoverAttempts: number;
  private readonly createTransport: () => RealtimeV2Transport;
  private readonly batchStt: RealtimeV2BatchStt;
  private readonly batchTts: RealtimeV2BatchTts;
  private readonly toolHandler: RealtimeV2Options['toolHandler'];

  private state: RealtimeV2State = 'idle';
  private mode: RealtimeV2Mode = 'realtime';
  private transport: RealtimeV2Transport | null = null;
  private nowMs = 0;
  private connectedAtMs: number | null = null;
  private connectedMs = 0;
  private turns = 0;
  private userTurns = 0;
  private agentTurns = 0;
  private fallbacks = 0;
  private recoveries = 0;
  private recoverAttempts = 0;
  private interrupts = 0;
  private ducks = 0;
  private firstPartialLatencyMs: number | null = null;
  private turnLatencyMs: number | null = null;
  private turnLatencies: number[] = [];
  private speechEndedAtMs: number | null = null;
  private replyIndex = 0;
  private replyWords: string[] = [];
  private replyWordIndex = 0;
  private replyWordDueMs = 0;
  private micClosedUntilMs = 0;
  private queuedBatchFrames: Uint8Array[] = [];
  private batchTurnPending = false;
  private recoverDueMs: number | null = null;
  private closedIntentionally = false;

  constructor(options: RealtimeV2Options, sink: RealtimeV2EventSink | null = null) {
    if (!REALTIME_V2_SESSION_ID_RE.test(options.sessionId)) {
      throw new Error(`Realtime v2 session id "${options.sessionId}" must be a slug (letters, digits, dashes, underscores, max 64 chars).`);
    }
    this.sessionId = options.sessionId;
    this.botId = options.botId ?? 'default';
    this.language = options.language ?? 'en';
    this.voice = options.voice ?? '';
    this.mockReplies = options.mockReplies ?? [REALTIME_V2_DEFAULT_MOCK_REPLY];
    this.mockWordMs = options.mockWordMs ?? 120;
    if (!Number.isFinite(this.mockWordMs) || this.mockWordMs < 0 || this.mockWordMs > 5000) {
      throw new Error('Realtime v2 mockWordMs must be a finite number in 0..5000.');
    }
    this.micReopenGraceMs = options.micReopenGraceMs ?? 300;
    if (!Number.isFinite(this.micReopenGraceMs) || this.micReopenGraceMs < 0 || this.micReopenGraceMs > 5000) {
      throw new Error('Realtime v2 micReopenGraceMs must be a finite number in 0..5000.');
    }
    this.recoverCooldownMs = options.recoverCooldownMs ?? 5000;
    if (!Number.isFinite(this.recoverCooldownMs) || this.recoverCooldownMs < 0 || this.recoverCooldownMs > 120000) {
      throw new Error('Realtime v2 recoverCooldownMs must be a finite number in 0..120000.');
    }
    this.maxRecoverAttempts = options.maxRecoverAttempts ?? 3;
    if (!Number.isInteger(this.maxRecoverAttempts) || this.maxRecoverAttempts < 0 || this.maxRecoverAttempts > 10) {
      throw new Error('Realtime v2 maxRecoverAttempts must be an integer in 0..10.');
    }
    const stabilityRepeats = options.partialStabilityRepeats ?? 2;
    this.partials = new PartialTranscriptBufferV2(stabilityRepeats);
    this.vad = new VadV10(options.vad ?? {}, (event) => this.onVadEvent(event));
    this.noise = new NoiseSuppressorV10(options.noise ?? {});
    this.bargeIn = new BargeInV9Controller(options.bargeIn ?? {}, null);
    this.transcript = new TranscriptStreamV9(options.transcript ?? {});
    this.createTransport = options.createTransport ?? (() => new MockRealtimeV2Transport());
    this.batchStt = options.batchStt ?? defaultBatchStt;
    this.batchTts = options.batchTts ?? defaultBatchTts;
    this.toolHandler = options.toolHandler;
    this.sink = sink;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getBotId(): string {
    return this.botId;
  }

  getState(): RealtimeV2State {
    return this.state;
  }

  getMode(): RealtimeV2Mode {
    return this.mode;
  }

  getNowMs(): number {
    return this.nowMs;
  }

  getVad(): VadV10 {
    return this.vad;
  }

  getNoiseSuppressor(): NoiseSuppressorV10 {
    return this.noise;
  }

  getBargeIn(): BargeInV9Controller {
    return this.bargeIn;
  }

  getTranscript(): TranscriptStreamV9 {
    return this.transcript;
  }

  getTransport(): RealtimeV2Transport | null {
    return this.transport;
  }

  getStats(): RealtimeV2Stats {
    const partialCounts = this.partials.getCounts();
    return {
      state: this.state,
      mode: this.mode,
      turns: this.turns,
      userTurns: this.userTurns,
      agentTurns: this.agentTurns,
      partials: partialCounts.partials,
      stablePartials: partialCounts.stablePartials,
      fallbacks: this.fallbacks,
      recoveries: this.recoveries,
      recoverAttempts: this.recoverAttempts,
      interrupts: this.interrupts,
      ducks: this.ducks,
      connectedMs: this.connectedMs + (this.connectedAtMs !== null ? this.nowMs - this.connectedAtMs : 0),
      firstPartialLatencyMs: this.firstPartialLatencyMs,
      turnLatencyMs: this.turnLatencyMs,
      meanTurnLatencyMs: this.turnLatencies.length > 0
        ? Math.round(this.turnLatencies.reduce((a, b) => a + b, 0) / this.turnLatencies.length)
        : null,
      vad: this.vad.getStats(),
      noise: this.noise.getStats(this.nowMs),
      bargeIn: this.bargeIn.getStats(),
      transcript: this.transcript.getStats(),
    };
  }

  transcriptMarkdown(): string {
    return transcriptV9Markdown(this.transcript);
  }

  /** Open the realtime transport and start listening. */
  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed') {
      throw new Error(`Realtime v2 session "${this.sessionId}" is already ${this.state}.`);
    }
    this.closedIntentionally = false;
    this.setState('connecting');
    this.transport = this.createTransport();
    this.transport.onMessage((message) => this.onTransportMessage(message));
    try {
      await this.transport.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transport = null;
      await this.fallBack('dial-timeout', `realtime dial failed: ${message}`);
      return;
    }
    this.connectedAtMs = this.nowMs;
    this.emit({ kind: 'mode', mode: 'realtime', reason: 'started', atMs: this.nowMs });
    this.setState('listening');
  }

  /** Close the session intentionally (no reconnect, no fallback). */
  disconnect(): void {
    this.closedIntentionally = true;
    this.recoverDueMs = null;
    if (this.connectedAtMs !== null) {
      this.connectedMs += this.nowMs - this.connectedAtMs;
      this.connectedAtMs = null;
    }
    this.transport?.disconnect();
    this.transport = null;
    this.setState('closed');
  }

  /** Force a fallback to batch mode (manual — e.g. the user toggles it). */
  async forceBatch(reason: string): Promise<void> {
    await this.fallBack('manual', reason);
  }

  /** Try realtime again now (used by the UI retry button and by the
   * automatic recovery timer). Returns false when recovery is not
   * available (already realtime, closed, or out of attempts). */
  async tryRecover(): Promise<boolean> {
    if (this.closedIntentionally || this.mode === 'realtime' || this.state === 'closed') return false;
    if (this.recoverAttempts >= this.maxRecoverAttempts) return false;
    this.recoverAttempts += 1;
    this.recoverDueMs = null;
    const transport = this.createTransport();
    transport.onMessage((message) => this.onTransportMessage(message));
    try {
      await transport.connect();
    } catch {
      this.scheduleRecovery();
      return false;
    }
    this.transport = transport;
    this.mode = 'realtime';
    this.recoveries += 1;
    this.connectedAtMs = this.nowMs;
    this.emit({ kind: 'recovered', atMs: this.nowMs, attempt: this.recoverAttempts });
    this.emit({ kind: 'mode', mode: 'realtime', reason: 'recovered', atMs: this.nowMs });
    this.setState(this.vad.isSpeaking() ? 'processing' : 'listening');
    return true;
  }

  /**
   * Feed one 20 ms PCM16 mic frame. Advances the virtual clock.
   * During the mic-reopen grace the frame is still fed to the VAD
   * (so the floor keeps adapting) but cannot start a turn.
   */
  feedAudio(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V10_FRAME_SAMPLES * 2) {
      throw new Error('Realtime v2 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (this.state === 'idle' || this.state === 'closed') return;
    const atMs = this.nowMs;
    this.nowMs += VAD_V10_FRAME_MS;
    const cleaned = this.noise.process(frame, atMs);
    const level = cleaned.outputRms;
    this.emit({ kind: 'audio-level', atMs, level });
    // Silence frames teach the noise profile; speech frames do not.
    if (level < 0.02) this.noise.learn(frame, atMs);
    // Grace after the agent stops: the echo tail of the agent's
    // last words must not become a phantom user turn, so mic
    // frames inside the grace are measured but never reach the
    // VAD or the transport.
    if (atMs < this.micClosedUntilMs) return;
    if (this.mode === 'batch') {
      this.queuedBatchFrames.push(new Uint8Array(cleaned.frame));
      // In batch mode the VAD still cuts turns — it just commits
      // them through the batch STT instead of the realtime socket.
      this.vad.feed(cleaned.frame);
      return;
    }
    // The pipeline never marks frames as echo: it cannot know
    // whether a frame is the user's voice or the agent's playback
    // leaking into the mic — only the host app knows what it just
    // played. Marking every frame while speaking as echo would
    // silence barge-in entirely (v9's echo guard is for echo-only
    // frames, not for all speech during playback).
    this.vad.feed(cleaned.frame);
    if (this.transport?.connected) {
      try {
        this.transport.sendAudio(toBase64(cleaned.frame));
      } catch {
        void this.fallBack('transport-error', 'sendAudio threw while the transport was connected');
      }
    }
  }

  /** Advance the virtual clock (drives mock replies + recovery). */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      throw new Error('Realtime v2 tick(ms) must be a finite number in 0..60000.');
    }
    this.nowMs += ms;
    this.advanceReply();
    if (this.recoverDueMs !== null && this.nowMs >= this.recoverDueMs && !this.closedIntentionally) {
      void this.tryRecover();
    }
  }

  /**
   * Drive one scripted mock turn without real audio: the user line
   * is committed as a turn, then the mock model streams its reply
   * word by word. Returns false when the session is not listening.
   */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    if (this.state !== 'listening' && this.state !== 'processing') return false;
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new Error('Realtime v2 simulateTurn needs a non-empty userText.');
    }
    const reply = modelReply ?? this.nextMockReply();
    this.transcript.noteFinal(userText.trim(), { speakerId: 'user', atMs: this.nowMs });
    this.userTurns += 1;
    this.turns += 1;
    this.startAgentReply(reply);
    return true;
  }

  /** Interrupt the agent reply now (explicit user action). */
  interrupt(reason = 'user'): BargeInV9InterruptResult | null {
    if (this.state !== 'speaking' && this.state !== 'processing') return null;
    const result = this.bargeIn.interrupt(this.nowMs);
    this.interrupts += 1;
    this.replyWords = [];
    this.replyWordIndex = 0;
    this.emit({ kind: 'barge-in', atMs: this.nowMs, result });
    this.setState('listening');
    return result;
  }

  /** Duck playback while the user speaks over the agent. */
  duck(): boolean {
    const ducked = this.bargeIn.duck(this.nowMs);
    if (ducked) {
      this.ducks += 1;
      this.emit({ kind: 'duck', atMs: this.nowMs, factor: this.bargeIn.getOptions().duckFactor });
    }
    return ducked;
  }

  /** Restore playback volume after ducking. */
  resumePlayback(): boolean {
    const resumed = this.bargeIn.resume(this.nowMs);
    if (resumed) this.emit({ kind: 'resume', atMs: this.nowMs });
    return resumed;
  }

  private emit(event: RealtimeV2Event): void {
    this.sink?.(event);
  }

  private setState(next: RealtimeV2State): void {
    if (next === this.state) return;
    this.state = next;
    this.emit({ kind: 'state', state: next, atMs: this.nowMs });
  }

  private nextMockReply(): string {
    const reply = this.mockReplies[Math.min(this.replyIndex, this.mockReplies.length - 1)] ?? REALTIME_V2_DEFAULT_MOCK_REPLY;
    this.replyIndex += 1;
    return reply;
  }

  private onVadEvent(event: { kind: string; atMs: number; durationMs?: number }): void {
    if (event.kind === 'speech-start') {
      if (this.state === 'speaking' || this.state === 'processing') {
        // Barge-in: let the controller decide (policy + cooldown +
        // echo guard). `interrupt: true` cuts the reply; a grace
        // decision ducks playback while the user keeps talking.
        // speechMs is the VAD's minimum continuous speech — the
        // VAD only fires speech-start after that much speech, so
        // it is a lower bound of the real burst length.
        const decision = this.bargeIn.decideSpeechStart({
          nowMs: this.nowMs,
          speechMs: this.vad.getOptions().minSpeechMs,
          echoOnly: false,
        });
        if (decision.interrupt) {
          this.interrupt('barge-in');
        } else if (decision.reason === 'grace-expired') {
          this.duck();
        }
        return;
      }
      this.emit({ kind: 'speech-start', atMs: event.atMs });
      return;
    }
    if (event.kind === 'speech-end' && event.durationMs !== undefined) {
      this.emit({ kind: 'speech-end', atMs: event.atMs, durationMs: event.durationMs });
      this.speechEndedAtMs = this.nowMs;
      // Only a turn that ends while listening starts a reply. A
      // turn that ends while the agent is still speaking belongs
      // to a barge-in that the controller already decided (or
      // refused, under `confirm`) — starting a second reply on top
      // of the playing one would talk over the agent.
      if (this.state !== 'listening') return;
      if (this.mode === 'batch') {
        void this.commitBatchTurn();
        return;
      }
      this.setState('processing');
      this.bargeIn.beginThinking();
      // The mock model answers at once; a live host answers when
      // the transport delivers its first audio/text delta.
      this.startAgentReply(this.nextMockReply());
      return;
    }
    if (event.kind === 'backchannel' && event.durationMs !== undefined) {
      this.emit({ kind: 'backchannel', atMs: event.atMs, durationMs: event.durationMs });
      return;
    }
    if (event.kind === 'double-talk' && event.durationMs !== undefined) {
      this.duck();
    }
  }

  private onTransportMessage(message: RealtimeV2TransportMessage): void {
    if (message.kind === 'partial') {
      const pushed = this.partials.push(message.text, this.nowMs);
      if (this.firstPartialLatencyMs === null && this.connectedAtMs !== null) {
        this.firstPartialLatencyMs = this.nowMs - this.connectedAtMs;
      }
      this.emit({ kind: 'partial', atMs: this.nowMs, speakerId: 'user', text: pushed.text, stable: pushed.stable, latencyMs: pushed.latencyMs });
      return;
    }
    if (message.kind === 'final') {
      const kept = this.partials.clear();
      void kept;
      this.transcript.noteFinal(message.text, { speakerId: 'user', atMs: this.nowMs });
      this.userTurns += 1;
      this.turns += 1;
      this.emit({ kind: 'final', atMs: this.nowMs, speakerId: 'user', text: message.text });
      return;
    }
    if (message.kind === 'audio') {
      if (this.speechEndedAtMs !== null && this.turnLatencyMs === null) {
        this.turnLatencyMs = this.nowMs - this.speechEndedAtMs;
        this.turnLatencies.push(this.turnLatencyMs);
      }
      return;
    }
    if (message.kind === 'error') {
      void this.fallBack('transport-error', message.message);
      return;
    }
    if (message.kind === 'closed') {
      if (!this.closedIntentionally) {
        void this.fallBack('transport-closed', `transport closed (${message.code}): ${message.reason}`);
      }
    }
  }

  private startAgentReply(reply: string): void {
    const words = reply.split(/\s+/).filter(Boolean);
    this.replyWords = words;
    this.replyWordIndex = 0;
    this.replyWordDueMs = this.nowMs + this.mockWordMs;
    this.bargeIn.beginSpeaking(splitWordsV9(reply, Math.max(words.length * this.mockWordMs, 1)));
    this.setState('speaking');
    // Zero-word replies finish at once.
    if (words.length === 0) this.finishAgentReply();
  }

  private advanceReply(): void {
    if (this.state !== 'speaking' || this.replyWords.length === 0) return;
    if (this.nowMs < this.replyWordDueMs) return;
    // Stream every due word (a big tick catches up several words).
    while (this.replyWordIndex < this.replyWords.length && this.nowMs >= this.replyWordDueMs) {
      this.replyWordIndex += 1;
      this.replyWordDueMs += this.mockWordMs;
      this.bargeIn.advancePlayed(this.mockWordMs);
    }
    if (this.replyWordIndex >= this.replyWords.length) this.finishAgentReply();
  }

  private finishAgentReply(): void {
    const text = this.replyWords.join(' ');
    this.bargeIn.finishSpeaking();
    if (text.length > 0) {
      this.transcript.noteFinal(text, { speakerId: 'agent', atMs: this.nowMs });
      this.agentTurns += 1;
      this.turns += 1;
      this.emit({ kind: 'final', atMs: this.nowMs, speakerId: 'agent', text });
    }
    this.replyWords = [];
    this.replyWordIndex = 0;
    // Grace before the mic reopens: the echo tail of the agent's
    // last words must not become a phantom user turn.
    this.micClosedUntilMs = this.nowMs + this.micReopenGraceMs;
    this.setState('listening');
  }

  private async commitBatchTurn(): Promise<void> {
    if (this.batchTurnPending) return;
    this.batchTurnPending = true;
    const frames = this.queuedBatchFrames;
    this.queuedBatchFrames = [];
    try {
      const text = await this.batchStt(frames, { language: this.language });
      if (text.trim().length > 0) {
        this.transcript.noteFinal(text.trim(), { speakerId: 'user', atMs: this.nowMs });
        this.userTurns += 1;
        this.turns += 1;
        this.emit({ kind: 'final', atMs: this.nowMs, speakerId: 'user', text: text.trim() });
      }
      const reply = this.nextMockReply();
      const words = await this.batchTts(reply, { voice: this.voice, rate: 1 });
      this.startAgentReply(words.join(' '));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ kind: 'error', atMs: this.nowMs, message: `batch turn failed: ${message}` });
      this.setState('listening');
    } finally {
      this.batchTurnPending = false;
    }
  }

  private async fallBack(reason: RealtimeV2FallbackReason, detail: string): Promise<void> {
    if (this.closedIntentionally || this.state === 'closed') return;
    if (this.mode === 'batch' && reason !== 'manual') return;
    this.transport?.disconnect();
    this.transport = null;
    if (this.connectedAtMs !== null) {
      this.connectedMs += this.nowMs - this.connectedAtMs;
      this.connectedAtMs = null;
    }
    this.mode = 'batch';
    this.fallbacks += 1;
    this.emit({ kind: 'fallback', atMs: this.nowMs, reason, detail });
    this.emit({ kind: 'mode', mode: 'batch', reason, atMs: this.nowMs });
    this.setState('degraded');
    this.scheduleRecovery();
    // Batch mode keeps listening: queued audio still becomes turns
    // through the batch STT, so the call survives the drop.
    this.setState('listening');
  }

  private scheduleRecovery(): void {
    if (this.maxRecoverAttempts <= 0 || this.recoverAttempts >= this.maxRecoverAttempts) {
      this.recoverDueMs = null;
      return;
    }
    this.recoverDueMs = this.nowMs + this.recoverCooldownMs;
  }
}

/** Create a v2 pipeline (factory, mirrors `createMockVoiceSessionV9`). */
export function createRealtimeVoicePipelineV2(
  options: RealtimeV2Options,
  sink: RealtimeV2EventSink | null = null,
): RealtimeVoicePipelineV2 {
  return new RealtimeVoicePipelineV2(options, sink);
}

/** One-line summary of a v2 pipeline's counters. */
export function realtimeV2Summary(stats: RealtimeV2Stats): string {
  return (
    `Realtime v2: ${stats.state} (${stats.mode}), ${stats.turns} turns, ` +
    `${stats.partials} partials (${stats.stablePartials} stable), ` +
    `${stats.fallbacks} fallbacks, ${stats.recoveries} recoveries, ` +
    `${stats.interrupts} interrupts, first-partial ${stats.firstPartialLatencyMs ?? '-'} ms, ` +
    `turn ${stats.meanTurnLatencyMs ?? '-'} ms`
  );
}

/** Pipeline stats as Markdown (for the diagnostics panel). */
export function realtimeV2Markdown(stats: RealtimeV2Stats): string {
  const lines = [
    '## Realtime voice v2',
    '',
    `- state: ${stats.state}, mode: ${stats.mode}`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- partials: ${stats.partials}, stable: ${stats.stablePartials}`,
    `- fallbacks: ${stats.fallbacks}, recoveries: ${stats.recoveries}, recover attempts: ${stats.recoverAttempts}`,
    `- interrupts: ${stats.interrupts}, ducks: ${stats.ducks}`,
    `- connected: ${stats.connectedMs} ms`,
    `- first-partial latency: ${stats.firstPartialLatencyMs === null ? '-' : `${stats.firstPartialLatencyMs} ms`}`,
    `- turn latency: ${stats.turnLatencyMs === null ? '-' : `${stats.turnLatencyMs} ms`} (mean ${stats.meanTurnLatencyMs === null ? '-' : `${stats.meanTurnLatencyMs} ms`})`,
  ];
  return lines.join('\n');
}
