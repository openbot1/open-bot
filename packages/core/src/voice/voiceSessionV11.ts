/**
 * Realtime voice session v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v10 was a thin shell over the v2 pipeline; v11 is a thin shell
 * over the four v11 components, wired together so the whole call
 * runs on one virtual clock:
 *
 *   mic frame ──▶ VadV11 ──▶ speech-start ──▶ TurnTakingManagerV11
 *                                    └────▶ BargeInV11Controller
 *                                             │ interrupt?
 *                                             ▼
 *                                    TtsStreamV11.cancelPending()
 *   speech-end ──▶ turn ends ──▶ thinking ──▶ speakReply(text)
 *                                    └────▶ TtsStreamV11.feedTextDelta
 *                                             (chunks stream out,
 *                                              drained → listening)
 *
 * The wiring rules (each one is a test in tests/voice-v112.test.mjs):
 * - A VAD speech-start while the agent is speaking or thinking
 *   goes to the barge-in controller first (policy + cooldown +
 *   echo guard + smart confidence). `interrupt: true` cuts the
 *   reply (TTS queue cancelled, receipt kept as the cut point),
 *   hands the floor to the user and puts the machine through
 *   `interrupted → cooldown → listening`. `duck: true` ducks
 *   playback instead of cutting it.
 * - A VAD speech-start while listening opens a user turn; a
 *   speech-end closes it and (with `autoReply`, the mock default)
 *   starts the scripted mock reply through the TTS stream.
 * - An overlap (user starts while the agent speaks but the
 *   controller refuses to interrupt, e.g. `confirm` policy) is
 *   recorded by the turn manager as `overlap`; the next VAD
 *   speech-end resolves it in the user's favour.
 * - When the TTS stream drains, the agent turn closes and the
 *   machine returns to `listening` — the session never gets
 *   stuck in `speaking`.
 * - Silence timeouts and nudges come from the turn manager; the
 *   session only forwards them.
 *
 * Determinism: one virtual clock (`nowMs`, starts at 0).
 * `feedAudio()` advances it 20 ms per frame; `tick()` advances
 * it manually and drives the TTS stream, the barge-in cooldown
 * and the turn timeouts. Nothing here touches a sound card, a
 * network socket or a key — replies are scripted mock strings
 * and TTS audio is the mock sine synth.
 */

import { isValidPcm16Frame } from './audio';
import { frameRms } from './audioMockV11';
import {
  VadV11, VAD_V11_FRAME_MS, VAD_V11_FRAME_SAMPLES,
  vadV11Summary, vadV11Markdown, isVadV11PresetName,
  type VadV11Options, type VadV11Event, type VadV11Stats, type VadV11PresetName,
} from './vadV11';
import {
  BargeInV11Controller, splitWordsV11,
  bargeInV11Summary, bargeInV11Markdown,
  type BargeInV11Options, type BargeInV11Event, type BargeInV11InterruptResult,
  type BargeInV11Stats, type BargeInV11State,
} from './bargeInV11';
import {
  TurnTakingManagerV11,
  turnTakingV11Summary, turnTakingV11Markdown,
  type TurnTakingV11Options, type TurnTakingV11Event, type TurnTakingV11Stats,
} from './turnTakingV11';
import {
  TtsStreamV11,
  ttsStreamV11Summary, ttsStreamV11Markdown,
  type TtsStreamV11Options, type TtsStreamV11Event, type TtsStreamV11Stats,
  type TtsStreamCancelResult,
} from './ttsStreamV11';

/** Session id pattern (same shape as the v9/v10 managers). */
export const VOICE_V11_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default scripted mock reply (says plainly this is mock mode). */
export const VOICE_V11_DEFAULT_MOCK_REPLY =
  'Hello — this is mock realtime v11 mode. Add an API key in Settings to talk to a live model.';

/** UI status of a v11 voice session (what the panel renders). */
export type VoiceSessionV11Status = BargeInV11State | 'closed';

/** Events emitted by a v11 session. */
export type VoiceSessionV11Event =
  | { kind: 'state'; state: VoiceSessionV11Status; atMs: number }
  | { kind: 'vad'; event: VadV11Event }
  | { kind: 'barge-in'; event: BargeInV11Event }
  | { kind: 'turn'; event: TurnTakingV11Event }
  | { kind: 'tts'; event: TtsStreamV11Event }
  | { kind: 'reply-started'; atMs: number; text: string }
  | { kind: 'reply-cut'; atMs: number; result: BargeInV11InterruptResult; tts: TtsStreamCancelResult };

export type VoiceSessionV11EventSink = (event: VoiceSessionV11Event) => void;

/** Options for creating a `RealtimeVoiceSessionV11`. */
export interface VoiceSessionV11Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  vad?: VadV11Options;
  bargeIn?: BargeInV11Options;
  turnTaking?: TurnTakingV11Options;
  tts?: TtsStreamV11Options;
  /** Scripted mock replies, in order (last repeats). */
  mockReplies?: string[];
  /** Start a scripted mock reply on every user speech-end (default true). */
  autoReply?: boolean;
}

/** Counters for one session. */
export interface VoiceSessionV11Stats {
  sessionId: string;
  botId: string;
  state: VoiceSessionV11Status;
  language: string;
  voice: string;
  nowMs: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  ducks: number;
  replies: number;
  repliesCut: number;
  vad: VadV11Stats;
  bargeIn: BargeInV11Stats;
  turnTaking: TurnTakingV11Stats;
  tts: TtsStreamV11Stats;
}

/**
 * Realtime voice session v11: VAD v11 + barge-in v11 + turn-taking
 * v11 + streaming TTS v11, on one virtual clock.
 */
export class RealtimeVoiceSessionV11 {
  private readonly sessionId: string;
  private readonly botId: string;
  private readonly language: string;
  private readonly voice: string;
  private readonly vad: VadV11;
  private readonly bargeIn: BargeInV11Controller;
  private readonly turnTaking: TurnTakingManagerV11;
  private readonly tts: TtsStreamV11;
  private readonly sink: VoiceSessionV11EventSink | null;
  private readonly mockReplies: string[];
  private readonly autoReply: boolean;
  private closed = false;
  private connected = false;
  private nowMs = 0;
  private replyIndex = 0;
  private replies = 0;
  private repliesCut = 0;
  private lastCut: { bargeIn: BargeInV11InterruptResult; tts: TtsStreamCancelResult } | null = null;
  private lastState: VoiceSessionV11Status = 'idle';
  /**
   * Session time minus VAD time (ms). The VAD owns its own clock
   * (20 ms per fed frame) while the session clock also advances
   * on `tick()` — without this offset a `tick()` between two
   * audio frames would shift every VAD timestamp (and the
   * barge-in latency) by the ticked amount. Updated on every
   * `feedAudio()` and `tick()`.
   */
  private clockOffsetMs = 0;
  /** VAD-time speech-start of the user's current burst (null when silent). */
  private userSpeechStartedVadMs: number | null = null;
  /** Last virtual time the barge-in decision was re-evaluated. */
  private lastBargeInDecideAtMs: number | null = null;

  /** Translate a VAD-clock timestamp into session-clock time. */
  private sessionTimeOf(vadAtMs: number): number {
    return vadAtMs + this.clockOffsetMs;
  }

  constructor(options: VoiceSessionV11Options, sink: VoiceSessionV11EventSink | null = null) {
    if (!VOICE_V11_SESSION_ID_RE.test(options.sessionId)) {
      throw new Error(`Voice v11 session id "${options.sessionId}" must be a slug (letters, digits, dashes, underscores, max 64 chars).`);
    }
    this.sessionId = options.sessionId;
    this.botId = options.botId ?? 'default';
    this.language = options.language ?? 'en';
    this.voice = options.voice ?? '';
    this.sink = sink;
    this.mockReplies = options.mockReplies ?? [VOICE_V11_DEFAULT_MOCK_REPLY];
    this.autoReply = options.autoReply ?? true;
    this.vad = new VadV11(options.vad ?? {}, (event) => this.onVadEvent(event));
    this.bargeIn = new BargeInV11Controller(options.bargeIn ?? {}, (event) => {
      this.sink?.({ kind: 'barge-in', event });
      if (event.kind === 'transition') this.emitState();
    });
    this.turnTaking = new TurnTakingManagerV11(options.turnTaking ?? {}, (event) => {
      this.sink?.({ kind: 'turn', event });
    });
    this.tts = new TtsStreamV11(options.tts ?? {}, (event) => {
      this.sink?.({ kind: 'tts', event });
      if (event.kind === 'drained') this.onTtsDrained();
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getBotId(): string {
    return this.botId;
  }

  getLanguage(): string {
    return this.language;
  }

  getVoice(): string {
    return this.voice;
  }

  getStatus(): VoiceSessionV11Status {
    if (this.closed) return 'closed';
    return this.bargeIn.getState();
  }

  getNowMs(): number {
    return this.nowMs;
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  getVad(): VadV11 {
    return this.vad;
  }

  getBargeIn(): BargeInV11Controller {
    return this.bargeIn;
  }

  getTurnTaking(): TurnTakingManagerV11 {
    return this.turnTaking;
  }

  getTts(): TtsStreamV11 {
    return this.tts;
  }

  getLastCut(): { bargeIn: BargeInV11InterruptResult; tts: TtsStreamCancelResult } | null {
    return this.lastCut;
  }

  getStats(): VoiceSessionV11Stats {
    const turnStats = this.turnTaking.getStats(this.nowMs);
    const bargeInStats = this.bargeIn.getStats();
    return {
      sessionId: this.sessionId,
      botId: this.botId,
      state: this.getStatus(),
      language: this.language,
      voice: this.voice,
      nowMs: this.nowMs,
      turns: turnStats.turns,
      userTurns: turnStats.userTurns,
      agentTurns: turnStats.agentTurns,
      interrupts: bargeInStats.interrupts,
      ducks: bargeInStats.ducks,
      replies: this.replies,
      repliesCut: this.repliesCut,
      vad: this.vad.getStats(),
      bargeIn: bargeInStats,
      turnTaking: turnStats,
      tts: this.tts.getStats(),
    };
  }

  getSummary(): string {
    const s = this.getStats();
    return (
      `Realtime v11: ${s.state}, ${s.turns} turns (user ${s.userTurns}, agent ${s.agentTurns}), ` +
      `${s.interrupts} interrupts, ${s.ducks} ducks, ${s.replies} replies (${s.repliesCut} cut), ` +
      `TTS ${s.tts.chunks} chunks (${s.tts.chunksDone} done, ${s.tts.chunksCancelled} cancelled)`
    );
  }

  transcriptMarkdown(): string {
    const s = this.getStats();
    return [vadV11Markdown(s.vad), '', bargeInV11Markdown(s.bargeIn), '', turnTakingV11Markdown(s.turnTaking), '', ttsStreamV11Markdown(s.tts)].join('\n');
  }

  /** Open the session (mock transport — no socket, no key) and start listening. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error(`Voice v11 session "${this.sessionId}" is closed.`);
    if (this.connected) throw new Error(`Voice v11 session "${this.sessionId}" is already connected.`);
    this.connected = true;
    this.bargeIn.startListening(this.nowMs);
    this.turnTaking.start(this.nowMs);
    this.emitState();
  }

  /** Close the session intentionally (no reconnect). */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.tts.stopAll();
    this.bargeIn.endCall(this.nowMs);
    this.emitState();
  }

  /** Feed one 20 ms PCM16 mic frame (advances the virtual clock). */
  feedAudio(frame: Uint8Array, input: { echo?: boolean } = {}): void {
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V11_FRAME_SAMPLES * 2) {
      throw new Error('Realtime v11 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    if (!this.connected || this.closed) return;
    this.nowMs += VAD_V11_FRAME_MS;
    // Frame-start offset: session time of the VAD's current time.
    this.clockOffsetMs = (this.nowMs - VAD_V11_FRAME_MS) - this.vad.getNowMs();
    this.turnTaking.noteEnergy(frameRms(frame), this.nowMs);
    this.vad.feed(frame, input);
    // Re-decide barge-in while the user keeps talking: the VAD
    // only fires speech-start once, but the `smart` policy needs
    // the growing speech duration (and confidence) to decide
    // whether a short burst stays a duck or becomes a cut.
    // Throttled to every 100 ms so the attempt counter is not
    // inflated by the 20 ms frame rate.
    const state = this.bargeIn.getState();
    if (
      this.userSpeechStartedVadMs !== null &&
      (state === 'speaking' || state === 'ducked' || state === 'thinking') &&
      this.lastBargeInDecideAtMs !== null &&
      this.nowMs - this.lastBargeInDecideAtMs >= 100
    ) {
      this.lastBargeInDecideAtMs = this.nowMs;
      const decision = this.bargeIn.decideSpeechStart({
        nowMs: this.nowMs,
        speechMs: this.nowMs - this.sessionTimeOf(this.userSpeechStartedVadMs),
        confidence: this.vad.getProbability(),
        echoOnly: input.echo === true,
      });
      if (decision.interrupt) {
        this.interrupt('barge-in');
      } else if (decision.duck) {
        this.duck();
      }
    }
  }

  /** Advance the virtual clock (drives TTS playback, cooldowns, timeouts). */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      throw new Error('Realtime v11 tick(ms) must be a finite number in 0..60000.');
    }
    this.nowMs += ms;
    this.clockOffsetMs += ms;
    this.tts.tick(ms);
    this.bargeIn.tick(this.nowMs);
    this.turnTaking.tick(this.nowMs);
    this.emitState();
  }

  /** Feed streaming reply text (model deltas); `final` flushes the tail. */
  feedTextDelta(delta: string, input: { final?: boolean } = {}): ReturnType<TtsStreamV11['feedTextDelta']> {
    return this.tts.feedTextDelta(delta, input);
  }

  /**
   * Start speaking a reply: the agent thinks, then the text
   * streams into the TTS queue chunk by chunk. Returns false
   * when the agent is already speaking / thinking.
   */
  speakReply(text: string): boolean {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Realtime v11 speakReply needs non-empty text.');
    }
    const state = this.bargeIn.getState();
    if (state !== 'listening') return false;
    const clean = text.trim();
    this.turnTaking.beginThinking(this.nowMs);
    this.bargeIn.beginThinking(this.nowMs);
    const msPerChar = this.tts.getOptions().msPerChar;
    const totalMs = Math.max(clean.length * msPerChar, 1);
    this.bargeIn.beginSpeaking(splitWordsV11(clean, totalMs), this.nowMs);
    this.turnTaking.beginAgentTurn(this.nowMs);
    // Stream the reply in as deltas so the TTS chunker works the
    // same path live text takes (sentence boundaries → chunks).
    this.tts.feedTextDelta(clean, { final: true });
    this.replies += 1;
    this.sink?.({ kind: 'reply-started', atMs: this.nowMs, text: clean });
    this.emitState();
    return true;
  }

  /** Drive one scripted mock turn without real audio. */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    if (!this.connected || this.closed) return false;
    if (this.bargeIn.getState() !== 'listening') return false;
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new Error('Realtime v11 simulateTurn needs a non-empty userText.');
    }
    this.turnTaking.beginUserTurn(this.nowMs);
    this.turnTaking.endUserTurn(this.nowMs, 'speech-end');
    return this.speakReply(modelReply ?? this.nextMockReply());
  }

  /** Interrupt the agent reply now (explicit user action). */
  interrupt(reason = 'user'): BargeInV11InterruptResult | null {
    void reason;
    const state = this.bargeIn.getState();
    if (state !== 'speaking' && state !== 'ducked' && state !== 'thinking') return null;
    const result = this.bargeIn.interrupt(this.nowMs);
    if (!result.interrupted) return result;
    const ttsResult = this.tts.cancelPending();
    this.repliesCut += 1;
    this.lastCut = { bargeIn: result, tts: ttsResult };
    const floor = this.turnTaking.getFloor();
    if (floor === 'agent') {
      this.turnTaking.endAgentTurn(this.nowMs, 'barge-in');
      // The user is mid-speech (VAD still open): the barge-in
      // turn starts now, so the turn history records it.
      if (this.vad.isSpeaking()) this.turnTaking.beginUserTurn(this.nowMs);
    } else if (floor === 'overlap') {
      this.turnTaking.resolveOverlap('user', this.nowMs);
    } else if (floor === 'thinking') {
      this.turnTaking.cancelThinking(this.nowMs);
    }
    this.sink?.({ kind: 'reply-cut', atMs: this.nowMs, result, tts: ttsResult });
    this.emitState();
    return result;
  }

  /** Duck playback while the user speaks over the agent. */
  duck(): boolean {
    const ducked = this.bargeIn.duck(this.nowMs);
    if (ducked) this.emitState();
    return ducked;
  }

  /** Restore playback volume after ducking. */
  resumePlayback(): boolean {
    const resumed = this.bargeIn.resume(this.nowMs);
    if (resumed) this.emitState();
    return resumed;
  }

  /** Switch the VAD preset live (same validation as the VAD). */
  setVadPreset(preset: VadV11PresetName): unknown {
    if (!isVadV11PresetName(preset)) throw new Error('VAD v11 preset must be one of quiet, office, noisy, street.');
    return this.vad.reconfigure({ preset });
  }

  /** Pause TTS playback (keeps the queue). */
  pauseTts(): boolean {
    return this.tts.pause();
  }

  /** Resume TTS playback after a pause. */
  resumeTts(): boolean {
    return this.tts.resume();
  }

  private nextMockReply(): string {
    const reply = this.mockReplies[Math.min(this.replyIndex, this.mockReplies.length - 1)] ?? VOICE_V11_DEFAULT_MOCK_REPLY;
    this.replyIndex += 1;
    return reply;
  }

  private emitState(): void {
    const state = this.getStatus();
    if (state === this.lastState) return;
    this.lastState = state;
    this.sink?.({ kind: 'state', state, atMs: this.nowMs });
  }

  private onTtsDrained(): void {
    if (this.bargeIn.getState() !== 'speaking' && this.bargeIn.getState() !== 'ducked') return;
    if (this.turnTaking.getFloor() === 'agent') {
      this.turnTaking.endAgentTurn(this.nowMs, 'drained');
    }
    this.bargeIn.finishSpeaking(this.nowMs);
    this.emitState();
  }

  private onVadEvent(event: VadV11Event): void {
    // Forward VAD events on the session clock (see clockOffsetMs).
    const atMs = this.sessionTimeOf(event.atMs);
    this.sink?.({ kind: 'vad', event: { ...event, atMs } });
    if (event.kind === 'speech-start') {
      this.bargeIn.noteSpeechStarted(atMs);
      this.userSpeechStartedVadMs = event.atMs;
      this.lastBargeInDecideAtMs = this.nowMs;
      const state = this.bargeIn.getState();
      if (state === 'speaking' || state === 'ducked' || state === 'thinking') {
        const decision = this.bargeIn.decideSpeechStart({
          nowMs: this.nowMs,
          speechMs: this.vad.getOptions().minSpeechMs,
          confidence: event.confidence,
          echoOnly: false,
        });
        if (decision.interrupt) {
          this.interrupt('barge-in');
        } else if (decision.duck) {
          this.duck();
        }
        return;
      }
      this.turnTaking.beginUserTurn(this.nowMs);
      return;
    }
    if (event.kind === 'speech-end') {
      this.bargeIn.noteSpeechEnded();
      this.userSpeechStartedVadMs = null;
      this.lastBargeInDecideAtMs = null;
      this.turnTaking.endUserTurn(this.nowMs, 'speech-end');
      if (this.autoReply && this.bargeIn.getState() === 'listening') {
        this.speakReply(this.nextMockReply());
      }
      return;
    }
    if (event.kind === 'turn-merged') {
      // Same user turn continues — nothing to hand off.
      return;
    }
    if (event.kind === 'backchannel' || event.kind === 'false-start') {
      this.bargeIn.noteSpeechEnded();
      this.userSpeechStartedVadMs = null;
      this.lastBargeInDecideAtMs = null;
      return;
    }
    if (event.kind === 'double-talk') {
      this.duck();
    }
  }
}

/** Create a mock v11 session (the manager and the tools use this). */
export function createMockVoiceSessionV11(
  options: VoiceSessionV11Options,
  sink: VoiceSessionV11EventSink | null = null,
): RealtimeVoiceSessionV11 {
  return new RealtimeVoiceSessionV11(options, sink);
}

/** Manager options. */
export interface VoiceV11ManagerOptions {
  /** Default mock replies for sessions created without their own. */
  mockReplies?: string[];
}

/**
 * In-memory registry of v11 sessions. Everything is local: sessions
 * run on the mock TTS synth unless the host wires a live synth;
 * no key is ever read here.
 */
export class VoiceV11Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV11>();
  private readonly mockReplies: string[] | undefined;

  constructor(options: VoiceV11ManagerOptions = {}) {
    this.mockReplies = options.mockReplies;
  }

  create(options: VoiceSessionV11Options & { connectNow?: boolean }): RealtimeVoiceSessionV11 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v11 session "${options.sessionId}" already exists.`);
    }
    const session = new RealtimeVoiceSessionV11(
      { ...(this.mockReplies ? { mockReplies: this.mockReplies } : {}), ...options },
      null,
    );
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) void session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV11 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV11[] {
    return [...this.sessions.values()];
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.disconnect();
    return this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }
}

/** One-line summary of a v11 session's stats. */
export function voiceSessionV11Summary(stats: VoiceSessionV11Stats): string {
  return (
    `Voice v11 session ${stats.sessionId} (${stats.botId}, ${stats.language}/${stats.voice || 'default'}): ` +
    `${stats.state}, ${stats.turns} turns, ${stats.interrupts} interrupts, ${stats.ducks} ducks, ` +
    `${stats.replies} replies (${stats.repliesCut} cut)`
  );
}

/** Session stats as Markdown (for the diagnostics panel). */
export function voiceSessionV11Markdown(stats: VoiceSessionV11Stats): string {
  const lines = [
    `# Voice session v11 — ${stats.sessionId}`,
    '',
    `- state: ${stats.state}, bot: ${stats.botId}, language: ${stats.language}, voice: ${stats.voice || 'default'}`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- interrupts: ${stats.interrupts}, ducks: ${stats.ducks}`,
    `- replies: ${stats.replies} (${stats.repliesCut} cut)`,
    `- now: ${stats.nowMs} ms`,
    '',
    vadV11Summary(stats.vad),
    '',
    bargeInV11Summary(stats.bargeIn),
    '',
    turnTakingV11Summary(stats.turnTaking),
    '',
    ttsStreamV11Summary(stats.tts),
  ];
  return lines.join('\n');
}
