/**
 * Voice session v4 (v1.05, Team T5 — realtime voice v4).
 *
 * Composition, not a rewrite: one `VoiceSessionV3` (v1.03 — the
 * durable long call: checkpoints + resume + media + barge-in v3)
 * plus the three v1.05 pieces around it:
 *
 *   - `VoiceLatencyPipeline` — per-turn, per-stage latency with
 *     p50 / p95 / p99, an adaptive jitter buffer, and a
 *     balanced / low-latency mode switch. The session wires only
 *     what it can observe honestly: turn latency is
 *     request → first audio chunk; stage marks (capture / VAD /
 *     STT / LLM / TTS) come from the caller that measured them
 *     (local stack, tests) via `markStage()`. A stage nobody
 *     measured stays "not measured" in the report — the session
 *     never splits one observed duration across stages it did
 *     not see.
 *   - `BargeInV4Controller` — the frame-level detector (energy
 *     gate + VAD + debounce) on the local path. When it confirms
 *     an interrupt, v4 cancels the session reply through v3 and
 *     measures the TTS stop against the 50 ms budget.
 *   - Voice turn history: every final transcript and every user
 *     turn the session records, kept in order with its time and
 *     whether it was cut — what the panel's turn history shows.
 *
 * Events: every `VoiceSessionV3` event is forwarded unchanged,
 * plus v4 kinds (`latency-report`, `barge-in-v4`,
 * `latency-mode`). All live paths stay mock unless the caller
 * passes a live transport factory — v4 never dials anything
 * itself. `createMockVoiceSessionV4()` is the mock factory the
 * session manager and the tools use.
 */
import type { RealtimeConfig, RealtimeSessionState } from './types';
import { VoiceSessionV3, type VoiceSessionV3Event, type VoiceSessionV3Options } from './voiceSessionV3';
import {
  VoiceLatencyPipeline,
  type VoiceLatencyMode,
  type VoiceLatencyModeConfig,
  type VoiceLatencyReport,
  type VoiceLatencyStage,
} from './latencyPipeline';
import {
  BargeInV4Controller,
  buildResumeUtterance,
  type BargeInV4Decision,
  type BargeInV4InterruptResult,
  type BargeInV4Options,
  type BargeInV4Stats,
} from './bargeInV4';
import { MockRealtimeTransport } from './mockTransport';
import type { VoiceTurn } from './longSession';

/** One voice turn for the panel's history. */
export interface VoiceV4TurnHistoryEntry {
  speaker: 'user' | 'model';
  text: string;
  /** True when this model turn was cut by a barge-in. */
  interrupted: boolean;
  /** True when the text is only the partial that was spoken. */
  partial: boolean;
  at: number;
}

/** Extra events the v4 wrapper emits (on top of the v3 events). */
export type VoiceSessionV4Event =
  | VoiceSessionV3Event
  | { kind: 'latency-report'; report: VoiceLatencyReport; at: number }
  | {
      kind: 'barge-in-v4';
      decision: BargeInV4Decision;
      result: BargeInV4InterruptResult;
      at: number;
    }
  | { kind: 'latency-mode'; mode: VoiceLatencyMode; config: VoiceLatencyModeConfig; at: number };

export type VoiceSessionV4EventSink = (event: VoiceSessionV4Event) => void;

/** Stats for the panel / diagnostics. */
export interface VoiceSessionV4Stats {
  latency: VoiceLatencyReport;
  bargeInV4: BargeInV4Stats;
  v3: ReturnType<VoiceSessionV3['getV3Stats']>;
  turns: number;
  historyEntries: number;
  /** Last measured connect duration (ms, null when never connected). */
  lastConnectMs: number | null;
}

export interface VoiceSessionV4Options {
  /** Options for the inner `VoiceSessionV3`. */
  v3: VoiceSessionV3Options;
  /** Starting latency mode. Default 'balanced'. */
  latencyMode?: VoiceLatencyMode;
  /** Barge-in v4 options (energy gate / debounce / budget). */
  bargeInV4?: BargeInV4Options;
  /**
   * Stop function the v4 interrupt measures (the TTS stop). When
   * absent, the interrupt measures the v3 cancel itself. A test
   * stop may return the ms it took, or advance the fake clock.
   */
  stopTts?: () => number | Promise<number> | void | Promise<void>;
  /** Max turn-history entries kept. Default 100. */
  maxHistoryEntries?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (v3 events + v4 events). */
  onEvent?: VoiceSessionV4EventSink;
}

/** Default mock reply delay (ms) for mock v4 sessions. */
export const VOICE_V4_MOCK_REPLY_DELAY_MS = 10;

export class VoiceSessionV4 {
  private readonly v3: VoiceSessionV3;
  private readonly pipeline: VoiceLatencyPipeline;
  private readonly bargeInV4: BargeInV4Controller;
  private readonly stopTts: VoiceSessionV4Options['stopTts'];
  private readonly maxHistoryEntries: number;
  private readonly clock: () => number;
  private readonly onEvent: VoiceSessionV4EventSink | undefined;
  private readonly history: VoiceV4TurnHistoryEntry[] = [];
  private lastConnectMs: number | null = null;
  private turnAudioSeen = false;

  constructor(options: VoiceSessionV4Options) {
    this.clock = options.clock ?? Date.now;
    this.stopTts = options.stopTts;
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? 100);
    this.onEvent = options.onEvent;
    this.pipeline = new VoiceLatencyPipeline({
      sessionId: options.v3.v2.session.provider ?? '',
      mode: options.latencyMode ?? 'balanced',
      clock: this.clock,
    });
    this.bargeInV4 = new BargeInV4Controller({
      ...(options.bargeInV4 ?? {}),
      clock: this.clock,
    });
    this.v3 = new VoiceSessionV3({
      ...options.v3,
      clock: this.clock,
      onEvent: (e) => this.handleV3Event(e),
    });
  }

  // -- passthroughs -------------------------------------------------------

  getState(): RealtimeSessionState {
    return this.v3.getState();
  }

  isConnected(): boolean {
    return this.v3.isConnected();
  }

  getSessionId(): string {
    return this.v3.getSessionId();
  }

  getTurnCount(): number {
    return this.v3.getTurnCount();
  }

  getBargeInCount(): number {
    return this.v3.getBargeInCount();
  }

  sendAudio(frame: Uint8Array): void {
    this.v3.sendAudio(frame);
  }

  pushAudioFrame(frame: Uint8Array): void {
    this.v3.pushAudioFrame(frame);
  }

  commitAudio(): void {
    this.v3.commitAudio();
    this.pipeline.startTurn();
  }

  /** User turn submitted: the turn clock starts here. */
  requestResponse(): void {
    this.v3.requestResponse();
    this.pipeline.startTurn();
  }

  sendToolResult(callId: string, output: string): void {
    this.v3.sendToolResult(callId, output);
  }

  startTalk(): boolean {
    return this.v3.startTalk();
  }

  endTalk(): boolean {
    return this.v3.endTalk();
  }

  setTurnMode(mode: Parameters<VoiceSessionV3['setTurnMode']>[0]): void {
    this.v3.setTurnMode(mode);
  }

  getLatencyStats(): ReturnType<VoiceSessionV3['getLatencyStats']> {
    return this.v3.getLatencyStats();
  }

  getHealth(): ReturnType<VoiceSessionV3['getHealth']> {
    return this.v3.getHealth();
  }

  getLongSessionTurns(): VoiceTurn[] {
    return this.v3.getLongSessionTurns();
  }

  noteUserTurn(text: string, mediaIds?: string[]): VoiceTurn | null {
    const turn = this.v3.noteUserTurn(text, mediaIds);
    if (turn) this.pushHistory({ speaker: 'user', text, interrupted: false, partial: false, at: this.clock() });
    return turn;
  }

  /** Hand the v3 wrapper through (checkpoints, resume, media, v3 barge-in). */
  getV3(): VoiceSessionV3 {
    return this.v3;
  }

  getBargeInV4(): BargeInV4Controller {
    return this.bargeInV4;
  }

  getPipeline(): VoiceLatencyPipeline {
    return this.pipeline;
  }

  // -- lifecycle ------------------------------------------------------------

  async connect(config: RealtimeConfig): Promise<void> {
    const started = this.clock();
    await this.v3.connect(config);
    this.lastConnectMs = Math.max(0, this.clock() - started);
    this.pipeline.setJitterBufferMs(this.pipeline.getModeConfig().jitterBufferMs);
  }

  disconnect(): void {
    if (this.pipeline.isTurnOpen()) this.pipeline.endTurn();
    this.bargeInV4.modelSpeechEnded();
    this.v3.disconnect();
  }

  dispose(): void {
    this.disconnect();
    this.v3.dispose();
  }

  // -- latency --------------------------------------------------------------

  getLatencyMode(): VoiceLatencyMode {
    return this.pipeline.getMode();
  }

  getLatencyModeConfig(): VoiceLatencyModeConfig {
    return this.pipeline.getModeConfig();
  }

  /** Switch latency mode mid-call; emits `latency-mode`. */
  setLatencyMode(mode: VoiceLatencyMode): VoiceLatencyModeConfig {
    const config = this.pipeline.setMode(mode);
    this.emit({ kind: 'latency-mode', mode: this.pipeline.getMode(), config, at: this.clock() });
    return config;
  }

  /**
   * Mark a pipeline stage complete (the caller measured it —
   * local STT / TTS / VAD report their own ms). Returns the
   * recorded duration, or null when no turn is open.
   */
  markStage(stage: VoiceLatencyStage, at?: number): number | null {
    return this.pipeline.markStage(stage, at);
  }

  /** Record a stage duration the caller timed itself. */
  recordStage(stage: VoiceLatencyStage, ms: number): void {
    this.pipeline.recordStage(stage, ms);
  }

  /** Per-session latency report (stages never measured stay null). */
  getLatencyReport(): VoiceLatencyReport {
    return this.pipeline.getReport();
  }

  /** Turn history for the panel (oldest first, capped). */
  getTurnHistory(): VoiceV4TurnHistoryEntry[] {
    return this.history.map((h) => ({ ...h }));
  }

  getV4Stats(): VoiceSessionV4Stats {
    return {
      latency: this.pipeline.getReport(),
      bargeInV4: this.bargeInV4.getStats(),
      v3: this.v3.getV3Stats(),
      turns: this.v3.getTurnCount(),
      historyEntries: this.history.length,
      lastConnectMs: this.lastConnectMs,
    };
  }

  // -- barge-in v4 ----------------------------------------------------------

  /**
   * The model started speaking on the local TTS path: v4 starts
   * watching for barge-in (the provider path does this from the
   * 'audio' event instead). The partial text is what the model
   * has said so far — it is kept if the reply gets cut.
   */
  noteModelSpeechStarted(partialText = ''): void {
    this.bargeInV4.modelSpeechStarted(partialText);
  }

  /**
   * One mic frame on the local path. When the energy gate + VAD
   * + debounce all agree, the session reply is cancelled through
   * v3 and the TTS stop is measured against the 50 ms budget.
   * Returns the frame decision (and, when it interrupted, the
   * measured stop).
   */
  async noteAudioFrameV4(input: { rms: number; vadActive?: boolean }): Promise<{
    decision: BargeInV4Decision;
    result: BargeInV4InterruptResult | null;
  }> {
    const decision = this.bargeInV4.noteAudioFrame(input);
    if (decision.action !== 'interrupt') return { decision, result: null };
    const result = await this.interruptV4();
    return { decision, result };
  }

  /**
   * Cancel the reply now through v3, measuring the TTS stop.
   * The partial the model had spoken is kept for resume.
   */
  async interruptV4(): Promise<BargeInV4InterruptResult> {
    const stopTts = this.stopTts;
    const result = await this.bargeInV4.interrupt(async () => {
      const before = this.clock();
      this.v3.interruptV3();
      if (stopTts) {
        const returned = await stopTts();
        if (typeof returned === 'number') return returned;
      }
      return Math.max(0, this.clock() - before);
    });
    if (result.partialText) {
      this.pushHistory({
        speaker: 'model',
        text: result.partialText,
        interrupted: true,
        partial: true,
        at: this.clock(),
      });
    }
    this.emit({
      kind: 'barge-in-v4',
      decision: {
        action: 'interrupt',
        reason: 'confirmed',
        frames: 0,
        framesNeeded: 0,
        rms: 0,
        state: this.bargeInV4.getState(),
        at: result.at,
      },
      result,
      at: result.at,
    });
    return result;
  }

  /** "Continue from here" prompt for the turn after a cut reply. */
  buildResumeUtterance(): string {
    return buildResumeUtterance(this.bargeInV4.getLastPartialText());
  }

  /** Resume the cut reply: v4 state back to listening + prompt. */
  resumePartialUtterance(): { partialText: string; resumePrompt: string } | null {
    const resumed = this.bargeInV4.resumePartial();
    if (!resumed) return null;
    return { partialText: resumed.partial.text, resumePrompt: resumed.resumePrompt };
  }

  getBargeInV4Stats(): BargeInV4Stats {
    return this.bargeInV4.getStats();
  }

  // -- internals ------------------------------------------------------------

  private pushHistory(entry: VoiceV4TurnHistoryEntry): void {
    this.history.push(entry);
    while (this.history.length > this.maxHistoryEntries) this.history.shift();
  }

  private handleV3Event(event: VoiceSessionV3Event): void {
    switch (event.kind) {
      case 'audio': {
        if (!this.bargeInV4.isModelSpeaking()) {
          this.bargeInV4.modelSpeechStarted();
        }
        // First audio chunk of the turn ends the turn clock:
        // submit → first audio is the turn latency the user feels.
        if (this.pipeline.isTurnOpen() && !this.turnAudioSeen) {
          this.turnAudioSeen = true;
          this.pipeline.endTurn();
          this.emit({ kind: 'latency-report', report: this.pipeline.getReport(), at: this.clock() });
        }
        break;
      }
      case 'transcript': {
        this.bargeInV4.noteModelText(event.text);
        if (event.isFinal && event.text.trim()) {
          this.pushHistory({
            speaker: 'model',
            text: event.text,
            interrupted: false,
            partial: false,
            at: this.clock(),
          });
        }
        break;
      }
      case 'turn': {
        if (event.speaker === 'model') {
          this.bargeInV4.modelSpeechEnded();
          this.turnAudioSeen = false;
        }
        break;
      }
      case 'interrupted': {
        this.turnAudioSeen = false;
        break;
      }
      default:
        break;
    }
    this.emit(event);
  }

  private emit(event: VoiceSessionV4Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/**
 * Build a mock v4 session (MockRealtimeTransport, no key, no
 * network) — what the session manager and the voice tools use
 * when the caller did not pass a live transport factory.
 */
export function createMockVoiceSessionV4(
  options: {
    sessionId?: string;
    provider?: 'openai' | 'gemini' | 'openai-compatible';
    latencyMode?: VoiceLatencyMode;
    bargeInV4?: BargeInV4Options;
    clock?: () => number;
    onEvent?: VoiceSessionV4EventSink;
    replyDelayMs?: number;
  } = {},
): VoiceSessionV4 {
  const provider = options.provider ?? 'openai';
  return new VoiceSessionV4({
    v3: {
      v2: {
        session: {
          provider,
          transportFactory: (cb) =>
            new MockRealtimeTransport(cb, { replyDelayMs: options.replyDelayMs ?? VOICE_V4_MOCK_REPLY_DELAY_MS }, provider),
        },
        longSession: { maxContextChars: 10_000 },
      },
      clock: options.clock,
      onEvent: undefined,
    },
    latencyMode: options.latencyMode,
    bargeInV4: options.bargeInV4,
    clock: options.clock,
    onEvent: options.onEvent,
  });
}
