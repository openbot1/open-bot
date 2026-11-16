/**
 * Realtime voice session v12 (v1.13, Đội T5 — voice realtime v12).
 *
 * v11's session wires VAD + barge-in + turn-taking + streaming
 * TTS on one virtual clock. v12 does not rewire it — it *wraps*
 * a `RealtimeVoiceSessionV11` and layers the four v12
 * components on top, driven by the v11 session's own events:
 *
 *   mic frame ──▶ v11 session ──▶ 'vad' speech-start/end
 *                                      ├─▶ EndOfTurnDetectorV12
 *                                      │    (when is the turn over?)
 *                                      ├─▶ OverlapTrackerV12
 *                                      │    (user over agent? duck
 *                                      │     envelope + segment log)
 *                                      └─▶ TurnMachineV12
 *                                           (unified call phase)
 *                  v11 session ──▶ 'state' (idle/listening/
 *                  thinking/speaking/ducked/interrupted/cooldown)
 *                                      └─▶ TurnMachineV12 sync
 *                  v11 session ──▶ 'reply-cut'
 *                                      └─▶ InterruptContextV12
 *                                           (cut sentence + user
 *                                           words + resume strategy)
 *                  speakReply(text) ──▶ TtsStreamV12.planChunks
 *                                      (word timings + prosody +
 *                                      pacing for the panel)
 *
 * Rules:
 * - One virtual clock: the session clock is the v11 session's
 *   clock (`feedAudio` +20 ms per frame, `tick(ms)` manual).
 *   The turn machine, the end-of-turn detector and the overlap
 *   tracker all read it; nothing here reads wall time.
 * - The v11 session still owns barge-in policy, VAD and TTS
 *   playback. v12 never bypasses it: an interrupt goes through
 *   `inner.interrupt()`, a reply through `inner.speakReply()`,
 *   ducking through `inner.duck()` / `inner.resumePlayback()`.
 *   v12 adds the *record* of what happened and the *resume*.
 * - Resume: after a cut, `getLastInterrupt()` returns the full
 *   context record; `resumeReply()` speaks its `resumeText`
 *   under the chosen strategy (`continue` / `restart` /
 *   `summarize`; `drop` resumes nothing — the next turn
 *   answers the user instead).
 * - Partial user words arrive via `noteUserWord()` (partial
 *   STT from the host): they feed both the interrupt context
 *   (why the user cut in) and the open overlap segment (what
 *   the user said while talking over the agent).
 *
 * Determinism: mock replies + mock sine TTS, same as v11. No
 * sound card, no network, no key.
 */

import { isValidPcm16Frame } from './audio';
import {
  RealtimeVoiceSessionV11,
  VOICE_V11_DEFAULT_MOCK_REPLY,
  type VoiceSessionV11Options,
  type VoiceSessionV11Event,
  type VoiceSessionV11Stats,
} from './voiceSessionV11';
import {
  InterruptContextV12,
  bargeInV12Summary,
  bargeInV12Markdown,
  type BargeInV12Options,
  type BargeInV12Event,
  type BargeInV12ResumeStrategy,
  type BargeInV12Stats,
  type InterruptedUtteranceV12,
} from './bargeInV12';
import {
  TtsStreamV12,
  ttsStreamV12Summary,
  ttsStreamV12Markdown,
  type TtsStreamV12Options,
  type TtsStreamV12Event,
  type TtsStreamV12Stats,
  type TtsPlannedChunkV12,
} from './ttsStreamV12';
import {
  TurnMachineV12,
  EndOfTurnDetectorV12,
  turnMachineV12Summary,
  turnMachineV12Markdown,
  endOfTurnDetectorV12Summary,
  type TurnMachineV12Options,
  type TurnMachineV12Event,
  type TurnMachineV12Stats,
  type TurnV12State,
  type EndOfTurnDetectorV12Options,
  type EndOfTurnV12Decision,
  type EndOfTurnDetectorV12Stats,
} from './turnTakingV12';
import {
  OverlapTrackerV12,
  overlapV12Summary,
  overlapV12Markdown,
  type OverlapV12Options,
  type OverlapV12Event,
  type OverlapV12Stats,
  type OverlapV12Segment,
} from './overlapV12';

/** UI status of a v12 voice session (what the panel renders). */
export type VoiceSessionV12Status = TurnV12State | 'closed';

/** Events emitted by a v12 session. */
export type VoiceSessionV12Event =
  | { kind: 'state'; state: VoiceSessionV12Status; atMs: number }
  | { kind: 'v11'; event: VoiceSessionV11Event }
  | { kind: 'turn-machine'; event: TurnMachineV12Event }
  | { kind: 'overlap'; event: OverlapV12Event }
  | { kind: 'barge-in-v12'; event: BargeInV12Event }
  | { kind: 'end-of-turn'; decision: EndOfTurnV12Decision }
  | { kind: 'tts-v12'; event: TtsStreamV12Event }
  | { kind: 'reply-resumed'; atMs: number; strategy: BargeInV12ResumeStrategy; text: string }
  | { kind: 'reply-dropped'; atMs: number; id: number };

export type VoiceSessionV12EventSink = (event: VoiceSessionV12Event) => void;

/** Options for creating a `RealtimeVoiceSessionV12`. */
export interface VoiceSessionV12Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  vad?: VoiceSessionV11Options['vad'];
  bargeIn?: VoiceSessionV11Options['bargeIn'];
  turnTaking?: VoiceSessionV11Options['turnTaking'];
  tts?: VoiceSessionV11Options['tts'];
  /** Scripted mock replies, in order (last repeats). */
  mockReplies?: string[];
  /** Start a scripted mock reply on every user speech-end (default true). */
  autoReply?: boolean;
  bargeInV12?: BargeInV12Options;
  ttsV12?: TtsStreamV12Options;
  turnMachine?: TurnMachineV12Options;
  endOfTurn?: EndOfTurnDetectorV12Options;
  overlap?: OverlapV12Options;
}

/** Counters for one v12 session (v11 stats + v12 layers). */
export interface VoiceSessionV12Stats extends VoiceSessionV11Stats {
  state: VoiceSessionV12Status;
  turnMachine: TurnMachineV12Stats;
  endOfTurn: EndOfTurnDetectorV12Stats;
  overlap: OverlapV12Stats;
  bargeInV12: BargeInV12Stats;
  ttsV12: TtsStreamV12Stats;
  /** Planned chunks of the current / last reply. */
  plannedChunks: number;
  resumes: number;
  drops: number;
}

/**
 * Realtime voice session v12: a v11 session plus interrupt
 * context, planned TTS streaming, a unified turn machine, an
 * end-of-turn detector and an overlap tracker — one clock.
 */
export class RealtimeVoiceSessionV12 {
  private readonly sessionId: string;
  private readonly inner: RealtimeVoiceSessionV11;
  private readonly interruptContext: InterruptContextV12;
  private readonly ttsV12: TtsStreamV12;
  private readonly turnMachine: TurnMachineV12;
  private readonly endOfTurn: EndOfTurnDetectorV12;
  private readonly overlap: OverlapTrackerV12;
  private readonly sink: VoiceSessionV12EventSink | null;
  private readonly autoReply: boolean;
  private closed = false;
  private lastPlan: TtsPlannedChunkV12[] = [];
  private currentReplyText = '';
  private streamedReplyText = '';
  private resumes = 0;
  private drops = 0;
  private lastState: VoiceSessionV12Status = 'idle';

  constructor(options: VoiceSessionV12Options, sink: VoiceSessionV12EventSink | null = null) {
    this.sessionId = options.sessionId;
    this.sink = sink;
    this.autoReply = options.autoReply ?? true;
    this.interruptContext = new InterruptContextV12(options.bargeInV12 ?? {}, (event) => {
      this.sink?.({ kind: 'barge-in-v12', event });
    });
    this.ttsV12 = new TtsStreamV12(options.ttsV12 ?? {}, (event) => {
      this.sink?.({ kind: 'tts-v12', event });
    });
    this.turnMachine = new TurnMachineV12(options.turnMachine ?? {}, (event) => {
      this.sink?.({ kind: 'turn-machine', event });
    });
    this.endOfTurn = new EndOfTurnDetectorV12(options.endOfTurn ?? {}, (decision) => {
      this.sink?.({ kind: 'end-of-turn', decision });
    });
    this.overlap = new OverlapTrackerV12(options.overlap ?? {}, (event) => {
      this.sink?.({ kind: 'overlap', event });
    });
    this.inner = new RealtimeVoiceSessionV11(
      {
        sessionId: options.sessionId,
        ...(options.botId !== undefined ? { botId: options.botId } : {}),
        ...(options.language !== undefined ? { language: options.language } : {}),
        ...(options.voice !== undefined ? { voice: options.voice } : {}),
        ...(options.vad !== undefined ? { vad: options.vad } : {}),
        ...(options.bargeIn !== undefined ? { bargeIn: options.bargeIn } : {}),
        ...(options.turnTaking !== undefined ? { turnTaking: options.turnTaking } : {}),
        ...(options.tts !== undefined ? { tts: options.tts } : {}),
        ...(options.mockReplies !== undefined ? { mockReplies: options.mockReplies } : {}),
        autoReply: this.autoReply,
      },
      (event) => this.onV11Event(event),
    );
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getBotId(): string {
    return this.inner.getBotId();
  }

  getLanguage(): string {
    return this.inner.getLanguage();
  }

  getVoice(): string {
    return this.inner.getVoice();
  }

  getStatus(): VoiceSessionV12Status {
    if (this.closed) return 'closed';
    return this.turnMachine.getState();
  }

  getNowMs(): number {
    return this.inner.getNowMs();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  getInner(): RealtimeVoiceSessionV11 {
    return this.inner;
  }

  getInterruptContext(): InterruptContextV12 {
    return this.interruptContext;
  }

  getTtsV12(): TtsStreamV12 {
    return this.ttsV12;
  }

  getTurnMachine(): TurnMachineV12 {
    return this.turnMachine;
  }

  getEndOfTurn(): EndOfTurnDetectorV12 {
    return this.endOfTurn;
  }

  getOverlap(): OverlapTrackerV12 {
    return this.overlap;
  }

  /** Planned chunks (word timings + prosody) of the last reply. */
  getLastPlan(): TtsPlannedChunkV12[] {
    return this.lastPlan.map((c) => ({ ...c, wordTimings: c.wordTimings.map((w) => ({ ...w })), prosody: c.prosody.map((p) => ({ ...p })) }));
  }

  /** Latest interrupted utterance with its resume context, or null. */
  getLastInterrupt(): InterruptedUtteranceV12 | null {
    return this.interruptContext.getLast();
  }

  /** Current playback volume factor (ducking envelope). */
  getVolume(): number {
    return this.overlap.volumeAt(this.getNowMs());
  }

  getStats(): VoiceSessionV12Stats {
    const v11 = this.inner.getStats();
    const nowMs = this.getNowMs();
    return {
      ...v11,
      state: this.getStatus(),
      turnMachine: this.turnMachine.getStats(nowMs),
      endOfTurn: this.endOfTurn.getStats(nowMs),
      overlap: this.overlap.getStats(nowMs),
      bargeInV12: this.interruptContext.getStats(),
      ttsV12: this.ttsV12.getStats(),
      plannedChunks: this.lastPlan.length,
      resumes: this.resumes,
      drops: this.drops,
    };
  }

  getSummary(): string {
    const s = this.getStats();
    return (
      `Realtime v12: ${s.state}, ${s.turns} turns (user ${s.userTurns}, agent ${s.agentTurns}), ` +
      `${s.interrupts} interrupts (${s.bargeInV12.byStrategy.continue} continue, ${s.bargeInV12.byStrategy.restart} restart, ` +
      `${s.bargeInV12.byStrategy.summarize} summarize, ${s.bargeInV12.byStrategy.drop} drop), ` +
      `${s.overlap.overlaps} overlaps, ${s.resumes} resumes, ` +
      `TTS ${s.tts.chunks} chunks, ${s.plannedChunks} planned`
    );
  }

  transcriptMarkdown(): string {
    const s = this.getStats();
    return [
      this.inner.transcriptMarkdown(),
      '',
      turnMachineV12Markdown(s.turnMachine),
      '',
      endOfTurnDetectorV12Summary(s.endOfTurn),
      '',
      overlapV12Markdown(s.overlap, this.overlap.getSegments()),
      '',
      bargeInV12Markdown(s.bargeInV12),
      '',
      ttsStreamV12Markdown(s.ttsV12),
    ].join('\n');
  }

  /** Open the session (mock transport — no socket, no key) and start listening. */
  async connect(): Promise<void> {
    await this.inner.connect();
  }

  /** Close the session intentionally (no reconnect). */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.disconnect();
    this.turnMachine.endCall(this.getNowMs());
    this.emitState();
  }

  /** Feed one 20 ms PCM16 mic frame (advances the virtual clock). */
  feedAudio(frame: Uint8Array, input: { echo?: boolean } = {}): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('Realtime v12 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    this.inner.feedAudio(frame, input);
  }

  /** Advance the virtual clock (drives TTS, cooldowns, timeouts, end-of-turn). */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) {
      throw new Error('Realtime v12 tick(ms) must be a finite number in 0..60000.');
    }
    this.inner.tick(ms);
    this.ttsV12.tick(ms);
    this.turnMachine.tick(this.getNowMs());
    this.endOfTurn.tick(this.getNowMs());
    this.emitState();
  }

  /** Feed streaming reply text (model deltas); `final` flushes the tail and plans it. */
  feedTextDelta(delta: string, input: { final?: boolean } = {}): ReturnType<RealtimeVoiceSessionV11['feedTextDelta']> {
    const fed = this.inner.feedTextDelta(delta, input);
    this.streamedReplyText += delta;
    if (input.final === true && this.streamedReplyText.trim().length > 0) {
      this.lastPlan = this.ttsV12.planChunks(this.streamedReplyText);
      this.streamedReplyText = '';
    }
    return fed;
  }

  /**
   * Start speaking a reply: plan it with the v12 chunker (word
   * timings + prosody for the panel), then speak it through the
   * v11 session. Returns false when the agent is already
   * speaking / thinking.
   */
  speakReply(text: string): boolean {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Realtime v12 speakReply needs non-empty text.');
    }
    // Keep the planner's clock aligned with the session clock.
    const nowMs = this.getNowMs();
    if (nowMs > this.ttsV12.getNowMs()) this.ttsV12.tick(nowMs - this.ttsV12.getNowMs());
    this.lastPlan = this.ttsV12.planChunks(text.trim());
    this.currentReplyText = text.trim();
    this.streamedReplyText = '';
    return this.inner.speakReply(text);
  }

  /** Drive one scripted mock turn without real audio. */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    return this.inner.simulateTurn(userText, modelReply);
  }

  /** Interrupt the agent reply now (explicit user action). */
  interrupt(reason = 'user'): ReturnType<RealtimeVoiceSessionV11['interrupt']> {
    return this.inner.interrupt(reason);
  }

  /**
   * Resume the last interrupted reply under its strategy.
   * `strategy` overrides the recorded one. Returns false when
   * there is nothing to resume (no interrupt, or `drop`).
   */
  resumeReply(strategy?: BargeInV12ResumeStrategy): boolean {
    const last = this.interruptContext.getLast();
    if (!last) return false;
    if (strategy !== undefined) {
      const updated = this.interruptContext.setStrategy(last.id, strategy, this.getNowMs());
      if (!updated) return false;
    }
    const record = this.interruptContext.getLast();
    if (!record || record.resumeStrategy === 'drop' || !record.resumeText) {
      if (record) {
        this.drops += 1;
        this.sink?.({ kind: 'reply-dropped', atMs: this.getNowMs(), id: record.id });
      }
      return false;
    }
    const started = this.speakReply(record.resumeText);
    if (started) {
      this.resumes += 1;
      this.sink?.({ kind: 'reply-resumed', atMs: this.getNowMs(), strategy: record.resumeStrategy, text: record.resumeText });
    }
    return started;
  }

  /** Feed one partial-STT word the user spoke (interruption / overlap transcript). */
  noteUserWord(word: string, atMs?: number, confidence = 1): void {
    const nowMs = atMs ?? this.getNowMs();
    this.interruptContext.noteUserWord(word, nowMs, confidence);
    this.overlap.noteUserWord(word);
  }

  /** Duck playback while the user speaks over the agent. */
  duck(): boolean {
    return this.inner.duck();
  }

  /** Restore playback volume after ducking. */
  resumePlayback(): boolean {
    return this.inner.resumePlayback();
  }

  /** Pause TTS playback (keeps the queue). */
  pauseTts(): boolean {
    return this.inner.pauseTts();
  }

  /** Resume TTS playback after a pause. */
  resumeTts(): boolean {
    return this.inner.resumeTts();
  }

  private emitState(): void {
    const state = this.getStatus();
    if (state === this.lastState) return;
    this.lastState = state;
    this.sink?.({ kind: 'state', state, atMs: this.getNowMs() });
  }

  /**
   * Sync the v12 turn machine from a v11 barge-in state change.
   * The machine is driven semantically (user/agent turns open
   * and close) rather than by raw mirroring, so its history
   * stays meaningful.
   */
  private syncTurnMachine(state: string, atMs: number): void {
    const machine = this.turnMachine;
    const current = machine.getState();
    if (state === 'listening') {
      if (current === 'idle') machine.start(atMs);
      else if (current === 'speaking') machine.endAgentTurn(atMs, 'drained');
      else if (current === 'thinking') machine.transitionTo('listening', 'thinking-cancelled', atMs);
      else if (current === 'cooldown' || current === 'interrupted') machine.transitionTo('listening', 'cooldown-expired', atMs);
      return;
    }
    if (state === 'thinking') {
      if (current === 'listening') {
        const turn = machine.getCurrentTurn();
        if (turn?.speaker === 'user') machine.endUserTurn(atMs, 'speech-end');
        else machine.transitionTo('thinking', 'thinking-started', atMs);
      }
      return;
    }
    if (state === 'speaking' || state === 'ducked') {
      if (current === 'thinking' || current === 'listening') machine.beginAgentTurn(atMs);
      return;
    }
    if (state === 'interrupted') {
      if (current === 'speaking' || current === 'thinking' || current === 'listening') machine.interrupt(atMs);
      return;
    }
    if (state === 'cooldown') {
      if (current === 'interrupted') machine.transitionTo('cooldown', 'interrupt-settled', atMs);
      else if (current === 'speaking' || current === 'thinking' || current === 'listening') {
        machine.interrupt(atMs);
        machine.transitionTo('cooldown', 'interrupt-settled', atMs);
      }
      return;
    }
    if (state === 'idle' || state === 'closed') {
      machine.endCall(atMs);
    }
  }

  private onV11Event(event: VoiceSessionV11Event): void {
    this.sink?.({ kind: 'v11', event });
    const atMs = this.getNowMs();
    if (event.kind === 'state') {
      this.syncTurnMachine(event.state, atMs);
      this.emitState();
      return;
    }
    if (event.kind === 'reply-started') {
      this.currentReplyText = event.text;
      this.lastPlan = this.ttsV12.planChunks(event.text);
      this.overlap.noteAgentSpeaking(event.text, atMs);
      return;
    }
    if (event.kind === 'reply-cut') {
      const record = this.interruptContext.recordInterrupt({
        receipt: event.result,
        tts: event.tts,
        replyText: this.currentReplyText || VOICE_V11_DEFAULT_MOCK_REPLY,
      });
      void record;
      const open = this.overlap.getCurrentSegment();
      if (open) {
        this.overlap.resolveOverlap('user', atMs, 'barge-in cut the reply', event.result.cutWordIndex);
      }
      this.overlap.noteAgentStopped();
      this.emitState();
      return;
    }
    if (event.kind === 'vad') {
      const vadEvent = event.event;
      if (vadEvent.kind === 'speech-start') {
        this.endOfTurn.speechStart(atMs);
        const innerState = this.inner.getStatus();
        if (innerState === 'speaking' || innerState === 'ducked' || innerState === 'thinking') {
          this.overlap.noteUserSpeechStart(atMs, vadEvent.confidence);
        } else if (this.turnMachine.getState() === 'listening' && !this.turnMachine.getCurrentTurn()) {
          this.turnMachine.beginUserTurn(atMs);
        }
        return;
      }
      if (vadEvent.kind === 'speech-end') {
        this.endOfTurn.speechEnd(atMs);
        this.overlap.noteUserSpeechEnd(atMs);
        return;
      }
      if (vadEvent.kind === 'double-talk') {
        const innerState = this.inner.getStatus();
        if (innerState === 'speaking' || innerState === 'ducked') {
          this.overlap.noteUserSpeechStart(atMs, 0.8);
        }
        return;
      }
      return;
    }
    if (event.kind === 'tts' && event.event.kind === 'drained') {
      this.overlap.noteAgentStopped();
      return;
    }
  }
}

/** Create a mock v12 session (the manager and the tools use this). */
export function createMockVoiceSessionV12(
  options: VoiceSessionV12Options,
  sink: VoiceSessionV12EventSink | null = null,
): RealtimeVoiceSessionV12 {
  return new RealtimeVoiceSessionV12(options, sink);
}

/** Manager options. */
export interface VoiceV12ManagerOptions {
  /** Default mock replies for sessions created without their own. */
  mockReplies?: string[];
}

/**
 * In-memory registry of v12 sessions. Everything is local:
 * sessions run on the mock TTS synth unless the host wires a
 * live synth; no key is ever read here.
 */
export class VoiceV12Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV12>();
  private readonly mockReplies: string[] | undefined;

  constructor(options: VoiceV12ManagerOptions = {}) {
    this.mockReplies = options.mockReplies;
  }

  create(options: VoiceSessionV12Options & { connectNow?: boolean }): RealtimeVoiceSessionV12 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v12 session "${options.sessionId}" already exists.`);
    }
    const session = new RealtimeVoiceSessionV12(
      { ...(this.mockReplies ? { mockReplies: this.mockReplies } : {}), ...options },
      null,
    );
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) void session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV12 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV12[] {
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

/** One-line summary of a v12 session's stats. */
export function voiceSessionV12Summary(stats: VoiceSessionV12Stats): string {
  return (
    `Voice v12 session ${stats.sessionId} (${stats.botId}, ${stats.language}/${stats.voice || 'default'}): ` +
    `${stats.state}, ${stats.turns} turns, ${stats.interrupts} interrupts, ` +
    `${stats.overlap.overlaps} overlaps, ${stats.resumes} resumes, ${stats.drops} drops`
  );
}

/** Session stats as Markdown (for the diagnostics panel). */
export function voiceSessionV12Markdown(stats: VoiceSessionV12Stats): string {
  const lines = [
    `# Voice session v12 — ${stats.sessionId}`,
    '',
    `- state: ${stats.state}, bot: ${stats.botId}, language: ${stats.language}, voice: ${stats.voice || 'default'}`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- interrupts: ${stats.interrupts}, overlaps: ${stats.overlap.overlaps}`,
    `- resumes: ${stats.resumes}, drops: ${stats.drops}`,
    `- now: ${stats.nowMs} ms`,
    '',
    turnMachineV12Summary(stats.turnMachine),
    '',
    endOfTurnDetectorV12Summary(stats.endOfTurn),
    '',
    overlapV12Summary(stats.overlap),
    '',
    bargeInV12Summary(stats.bargeInV12),
    '',
    ttsStreamV12Summary(stats.ttsV12),
  ];
  return lines.join('\n');
}
