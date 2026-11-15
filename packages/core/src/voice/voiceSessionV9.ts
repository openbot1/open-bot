/**
 * Realtime voice session v9 (v1.10, Đội T5 — voice realtime v5).
 *
 * The v9 session is the piece that ties the v9 parts together for one
 * call — VAD v9 (`vadV9.ts`), barge-in v9 (`bargeInV9.ts`) and the
 * streaming transcript (`transcriptStreamV9.ts`) — around a four-state
 * machine the UI can render directly:
 *
 *   idle -> listening -> processing -> speaking -> listening ...
 *
 * - `idle`: created, not connected.
 * - `listening`: connected, mic open, VAD watching for speech.
 * - `processing`: the user finished a turn; the "model" is thinking
 *   (tool calls may run here, and barge-in may cancel them).
 * - `speaking`: the agent reply streams word by word; the user may
 *   barge in, which cuts the reply and keeps the exact cut point.
 *
 * Turn-taking: mic frames go in through `feedAudio()`; the VAD cuts
 * them into turns. A VAD speech-end commits the interim transcript
 * and moves the session to `processing`; the scripted mock model
 * then streams its reply through `speaking`. Tool calls in the
 * middle of a reply run through the injected `toolHandler` (the
 * session never calls a tool itself) and are attached to the live
 * transcript turn, so the panel shows *what the agent did while
 * talking*.
 *
 * Determinism: the session owns a virtual clock (`nowMs`, starts at
 * 0). `feedAudio()` advances it 20 ms per frame; `tick()` advances
 * it manually; `simulateTurn()` drives a whole scripted turn without
 * real timers. Nothing here touches a sound card, a network socket
 * or a key — the mock model is a script of reply strings.
 *
 * Live gate: `probeLiveVoiceV9Key(hasKey)` reports whether a live
 * provider key is already present (the caller supplies the check —
 * typically "is there a key in the Vault for this provider?"). The
 * session never reads a key, never dials, and treats "no key" as a
 * normal state, not an error: mock mode is the default, live mode is
 * an explicit opt-in the host wires later.
 */

import { MockVadV9, VAD_V9_FRAME_MS, VAD_V9_FRAME_SAMPLES, type VadV9Options, type VadV9PresetName, type VadV9Stats } from './vadV9';
import { BargeInV9Controller, splitWordsV9, type BargeInV9InterruptResult, type BargeInV9Options, type BargeInV9Policy, type BargeInV9Stats } from './bargeInV9';
import { TranscriptStreamV9, transcriptV9Markdown, type TranscriptV9Stats, type TranscriptV9Turn, type TranscriptV9Options } from './transcriptStreamV9';
import { isValidPcm16Frame } from './audio';

/** UI status of a v9 voice session (what the panel renders). */
export type VoiceSessionV9Status = 'idle' | 'listening' | 'speaking' | 'processing';

/** Input mode: hands-free VAD or hold-to-talk. */
export type VoiceSessionV9InputMode = 'auto' | 'push-to-talk';

/** Session id pattern (same shape as the v5/v8 managers). */
export const VOICE_V9_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default scripted mock reply (says plainly this is mock mode). */
export const VOICE_V9_DEFAULT_MOCK_REPLY =
  'Hello — this is mock realtime mode. Add an API key in Settings to talk to a live model.';

/** A tool call the mock model makes while speaking. */
export interface VoiceV9ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Word index in the reply after which the call runs. */
  afterWord?: number;
}

/** A handler the host injects to actually run tool calls. */
export type VoiceV9ToolHandler = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result: string }>;

/** Events emitted by a v9 session. */
export type VoiceSessionV9Event =
  | { kind: 'status'; status: VoiceSessionV9Status; atMs: number }
  | { kind: 'speech-start'; atMs: number }
  | { kind: 'speech-end'; atMs: number; durationMs: number }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'partial'; atMs: number; speakerId: string; text: string }
  | { kind: 'turn'; atMs: number; turn: TranscriptV9Turn }
  | { kind: 'tool-call'; atMs: number; name: string; args: Record<string, unknown> }
  | { kind: 'tool-result'; atMs: number; name: string; ok: boolean; result: string }
  | { kind: 'barge-in'; atMs: number; result: BargeInV9InterruptResult }
  | { kind: 'duck'; atMs: number; factor: number }
  | { kind: 'resume'; atMs: number }
  | { kind: 'ptt'; pressed: boolean; atMs: number }
  | { kind: 'error'; atMs: number; message: string };

export type VoiceSessionV9EventSink = (event: VoiceSessionV9Event) => void;

/** Options for creating a `RealtimeVoiceSessionV9`. */
export interface VoiceSessionV9Options {
  sessionId: string;
  botId?: string;
  language?: string;
  voice?: string;
  inputMode?: VoiceSessionV9InputMode;
  vad?: VadV9Options;
  bargeIn?: BargeInV9Options;
  transcript?: TranscriptV9Options;
  /** Scripted mock replies, in order (last repeats). */
  mockReplies?: string[];
  /** Tool calls the mock model makes, keyed by reply index. */
  mockToolCalls?: Record<number, VoiceV9ScriptedToolCall[]>;
  /** Host-injected tool runner (default: refuses — no tools bound). */
  toolHandler?: VoiceV9ToolHandler;
  /** Per-word streaming pace of the mock reply (ms, virtual clock). */
  mockWordMs?: number;
}

/** Counters for one session. */
export interface VoiceSessionV9Stats {
  status: VoiceSessionV9Status;
  turns: number;
  userTurns: number;
  agentTurns: number;
  partials: number;
  toolCalls: number;
  interrupts: number;
  ducks: number;
  pttPresses: number;
  connectedMs: number;
  vad: VadV9Stats;
  bargeIn: BargeInV9Stats;
  transcript: TranscriptV9Stats;
}

/** Live-key probe result (no key is ever read or returned here). */
export interface VoiceV9LiveProbe {
  /** True only when the caller confirms a key already exists. */
  liveAvailable: boolean;
  /** Human reason (`no-key-in-vault`, `key-present`, ...). */
  reason: string;
  checkedAtMs: number;
}

export function probeLiveVoiceV9Key(hasKey: () => boolean, nowMs = 0): VoiceV9LiveProbe {
  let present = false;
  try {
    present = hasKey();
  } catch {
    present = false;
  }
  return {
    liveAvailable: present,
    reason: present ? 'key-present' : 'no-key-in-vault',
    checkedAtMs: nowMs,
  };
}

/**
 * One realtime voice call (mock-first): VAD turn-taking, streaming
 * partial transcript, tool calls mid-speech, barge-in with cut point.
 */
export class RealtimeVoiceSessionV9 {
  readonly sessionId: string;
  readonly botId: string;
  readonly language: string;
  readonly voice: string;
  private inputMode: VoiceSessionV9InputMode;
  private readonly vad: MockVadV9;
  private readonly bargeIn: BargeInV9Controller;
  private readonly transcript: TranscriptStreamV9;
  private readonly sink: VoiceSessionV9EventSink | null;
  private readonly mockReplies: string[];
  private readonly mockToolCalls: Record<number, VoiceV9ScriptedToolCall[]>;
  private readonly toolHandler: VoiceV9ToolHandler;
  private readonly mockWordMs: number;
  private status: VoiceSessionV9Status = 'idle';
  private nowMs = 0;
  private connectedAtMs: number | null = null;
  private replyIndex = 0;
  private pttPressed = false;
  private currentReplyWords: string[] = [];
  private lastInterrupt: BargeInV9InterruptResult | null = null;
  private stats: Omit<VoiceSessionV9Stats, 'status' | 'vad' | 'bargeIn' | 'transcript' | 'connectedMs'> = {
    turns: 0, userTurns: 0, agentTurns: 0, partials: 0, toolCalls: 0,
    interrupts: 0, ducks: 0, pttPresses: 0,
  };

  constructor(options: VoiceSessionV9Options, sink: VoiceSessionV9EventSink | null = null) {
    if (!VOICE_V9_SESSION_ID_RE.test(options.sessionId)) {
      throw new Error('Voice v9 sessionId must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.');
    }
    this.sessionId = options.sessionId;
    this.botId = options.botId ?? 'default';
    this.language = options.language ?? 'en';
    this.voice = options.voice ?? 'default';
    this.inputMode = options.inputMode ?? 'auto';
    this.sink = sink;
    this.mockReplies = options.mockReplies && options.mockReplies.length > 0 ? [...options.mockReplies] : [VOICE_V9_DEFAULT_MOCK_REPLY];
    this.mockToolCalls = options.mockToolCalls ?? {};
    this.toolHandler = options.toolHandler ?? (async () => ({ ok: false, result: 'No tool handler bound to this voice session.' }));
    this.mockWordMs = Math.max(1, Math.floor(options.mockWordMs ?? 120));
    this.vad = new MockVadV9(options.vad ?? {}, (event) => this.onVadEvent(event));
    this.bargeIn = new BargeInV9Controller(options.bargeIn ?? {}, (event) => this.onBargeInEvent(event));
    this.transcript = new TranscriptStreamV9(options.transcript ?? {});
  }

  getStatus(): VoiceSessionV9Status {
    return this.status;
  }

  getNowMs(): number {
    return this.nowMs;
  }

  getInputMode(): VoiceSessionV9InputMode {
    return this.inputMode;
  }

  isPttPressed(): boolean {
    return this.pttPressed;
  }

  /** VAD v9 options of this session (for tools / the panel). */
  getVadOptions(): Required<VadV9Options> {
    return this.vad.getOptions();
  }

  /** Switch the VAD preset live. */
  setVadPreset(preset: VadV9PresetName): Required<VadV9Options> {
    return this.vad.reconfigure({ preset });
  }

  /** Barge-in v9 options of this session (for tools / the panel). */
  getBargeInOptions(): Required<BargeInV9Options> {
    return this.bargeIn.getOptions();
  }

  /** Switch the barge-in policy live. */
  setBargeInPolicy(policy: BargeInV9Policy): Required<BargeInV9Options> {
    return this.bargeIn.reconfigure({ policy });
  }

  /** Receipt of the last interrupt, if any (the cut point). */
  getLastInterrupt(): BargeInV9InterruptResult | null {
    return this.lastInterrupt
      ? { ...this.lastInterrupt, wordsPlayed: [...this.lastInterrupt.wordsPlayed], wordsDiscarded: [...this.lastInterrupt.wordsDiscarded] }
      : null;
  }

  getTranscript(): TranscriptStreamV9 {
    return this.transcript;
  }

  getTurns(): TranscriptV9Turn[] {
    return this.transcript.getTurns();
  }

  getStats(): VoiceSessionV9Stats {
    return {
      status: this.status,
      ...this.stats,
      connectedMs: this.connectedAtMs === null ? 0 : this.nowMs - this.connectedAtMs,
      vad: this.vad.getStats(),
      bargeIn: this.bargeIn.getStats(),
      transcript: this.transcript.getStats(),
    };
  }

  getSummary(): string {
    const s = this.getStats();
    return (
      `Voice v9 session ${this.sessionId} (${this.botId}): ${s.status}, ` +
      `${s.userTurns} user turns, ${s.agentTurns} agent turns, ${s.toolCalls} tool calls, ` +
      `${s.interrupts} interrupts, ${s.connectedMs} ms connected`
    );
  }

  transcriptMarkdown(): string {
    return transcriptV9Markdown(this.transcript);
  }

  /** Advance the virtual clock without audio (drives grace/cooldown). */
  tick(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Voice v9 tick ms must be a finite number >= 0.');
    this.nowMs += Math.floor(ms);
  }

  /** Connect (mock): idle -> listening. */
  connect(): void {
    if (this.status !== 'idle') throw new Error(`Voice v9 session ${this.sessionId} is already ${this.status} — connect only from idle.`);
    this.setStatus('listening');
    this.connectedAtMs = this.nowMs;
  }

  /** Disconnect: any state -> idle (keeps turns + stats for inspection). */
  disconnect(): void {
    if (this.status === 'speaking' || this.status === 'processing') {
      this.bargeIn.finishSpeaking();
    }
    this.transcript.commit({ atMs: this.nowMs });
    this.setStatus('idle');
    this.connectedAtMs = null;
    this.pttPressed = false;
  }

  /** Switch input mode (auto <-> push-to-talk). */
  setInputMode(mode: VoiceSessionV9InputMode): VoiceSessionV9InputMode {
    if (mode !== 'auto' && mode !== 'push-to-talk') throw new Error('Voice v9 input mode must be "auto" or "push-to-talk".');
    this.inputMode = mode;
    if (mode === 'auto' && this.pttPressed) this.pttPressed = false;
    return this.inputMode;
  }

  /** Push-to-talk press / release. Releasing ends the turn like a VAD speech-end. */
  async ptt(pressed: boolean): Promise<boolean> {
    if (this.inputMode !== 'push-to-talk') throw new Error('Voice v9 PTT only works in push-to-talk input mode.');
    if (pressed === this.pttPressed) return this.pttPressed;
    this.pttPressed = pressed;
    this.sink?.({ kind: 'ptt', pressed, atMs: this.nowMs });
    if (pressed) this.stats.pttPresses += 1;
    if (!pressed && this.status === 'listening') {
      await this.finishUserTurn();
    }
    return this.pttPressed;
  }

  /**
   * Feed one 20 ms PCM16 mic frame. In `auto` mode the VAD drives
   * turn-taking; in push-to-talk mode frames only flow while held.
   */
  feedAudio(frame: Uint8Array): boolean {
    if (this.status === 'idle') throw new Error('Voice v9 session is idle — connect() first.');
    if (!isValidPcm16Frame(frame) || frame.length !== VAD_V9_FRAME_SAMPLES * 2) {
      throw new Error('Voice v9 expects a 20 ms PCM16 frame (320 samples at 16 kHz).');
    }
    this.nowMs += VAD_V9_FRAME_MS;
    if (this.inputMode === 'push-to-talk' && !this.pttPressed) return false;
    if (this.status === 'speaking') {
      // Mic stays live while the agent speaks: VAD speech here is a
      // barge-in attempt, decided by the barge-in controller.
      const speech = this.vad.feed(frame);
      if (speech) this.maybeBargeIn();
      return speech;
    }
    if (this.status === 'listening') {
      return this.vad.feed(frame);
    }
    // Processing: keep the VAD warm but do not start a new turn.
    this.vad.feed(frame);
    return false;
  }

  /** Note interim STT text for the live turn (streaming partial). */
  notePartial(text: string, speakerId = 'user'): string {
    if (this.status === 'idle') throw new Error('Voice v9 session is idle — connect() first.');
    const capped = this.transcript.pushPartial(text, { speakerId, atMs: this.nowMs });
    this.stats.partials += 1;
    this.sink?.({ kind: 'partial', atMs: this.nowMs, speakerId, text: capped });
    return capped;
  }

  /** Note final user text and run the mock model reply (scripted turn). */
  async simulateTurn(userText: string, modelReply?: string): Promise<boolean> {
    if (this.status === 'idle') throw new Error('Voice v9 session is idle — connect() first.');
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new Error('Voice v9 simulateTurn needs non-empty user text.');
    }
    // If the agent is mid-reply, the new user turn barges in first.
    if (this.status === 'speaking') this.interrupt('user-turn');
    const turn = this.transcript.noteFinal(userText, { speakerId: 'user', atMs: this.nowMs });
    this.stats.turns += 1;
    this.stats.userTurns += 1;
    this.sink?.({ kind: 'turn', atMs: this.nowMs, turn });
    this.setStatus('processing');
    await this.runModelReply(modelReply);
    return true;
  }

  /** Run one tool call while the agent is speaking (or thinking). */
  async invokeToolDuringSpeech(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
    if (this.status !== 'speaking' && this.status !== 'processing') {
      throw new Error(`Voice v9 tool calls run while speaking or processing, not while ${this.status}.`);
    }
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error('Voice v9 tool name must be a non-empty string.');
    this.sink?.({ kind: 'tool-call', atMs: this.nowMs, name, args: { ...args } });
    let outcome: { ok: boolean; result: string };
    try {
      outcome = await this.toolHandler(name, args);
    } catch (err) {
      outcome = { ok: false, result: `Error: ${(err as Error).message}` };
    }
    this.stats.toolCalls += 1;
    this.transcript.attachToolCall({ name, args: { ...args }, result: outcome.result, ok: outcome.ok, atMs: this.nowMs });
    this.sink?.({ kind: 'tool-result', atMs: this.nowMs, name, ok: outcome.ok, result: outcome.result });
    return outcome;
  }

  /**
   * Cut the agent reply now (explicit interrupt). Returns the receipt:
   * cut word, played vs discarded audio, words kept vs dropped.
   */
  interrupt(reason: 'user-turn' | 'explicit' | 'vad' = 'explicit'): BargeInV9InterruptResult {
    const result = this.bargeIn.interrupt(this.nowMs);
    if (result.interrupted) {
      this.lastInterrupt = result;
      this.stats.interrupts += 1;
      this.currentReplyWords = [];
      // The cut reply is kept as a partial agent turn so the
      // transcript shows what was actually said, not the script.
      // The interim keeps its own speaker (no override here).
      const cutTurn = this.transcript.commit({ atMs: this.nowMs });
      if (cutTurn && cutTurn.speakerId === 'agent') {
        this.stats.turns += 1;
        this.stats.agentTurns += 1;
      } else if (cutTurn) {
        this.stats.turns += 1;
        this.stats.userTurns += 1;
      }
      this.setStatus('listening');
      this.sink?.({ kind: 'barge-in', atMs: this.nowMs, result });
    }
    return result;
  }

  /** Duck playback while the user talks over the agent. */
  duck(): boolean {
    return this.bargeIn.duck(this.nowMs);
  }

  /** Restore full playback volume after ducking. */
  resumePlayback(): boolean {
    return this.bargeIn.resume(this.nowMs);
  }

  /** Live-key probe (gate only — never reads a key, never dials). */
  liveProbe(hasKey: () => boolean): VoiceV9LiveProbe {
    return probeLiveVoiceV9Key(hasKey, this.nowMs);
  }

  private setStatus(next: VoiceSessionV9Status): void {
    if (this.status === next) return;
    this.status = next;
    this.sink?.({ kind: 'status', status: next, atMs: this.nowMs });
  }

  private onVadEvent(event: { kind: string; atMs: number; durationMs?: number }): void {
    if (event.kind === 'speech-start') {
      this.sink?.({ kind: 'speech-start', atMs: event.atMs });
      if (this.status === 'speaking') this.maybeBargeIn();
      return;
    }
    if (event.kind === 'speech-end') {
      this.sink?.({ kind: 'speech-end', atMs: event.atMs, durationMs: event.durationMs ?? 0 });
      if (this.status === 'listening') void this.finishUserTurn();
      return;
    }
    if (event.kind === 'backchannel') {
      this.sink?.({ kind: 'backchannel', atMs: event.atMs, durationMs: event.durationMs ?? 0 });
      return;
    }
    // false-start: nothing to do — no turn was committed.
  }

  private onBargeInEvent(event: import('./bargeInV9').BargeInV9Event): void {
    if (event.kind === 'duck') this.sink?.({ kind: 'duck', atMs: event.atMs, factor: event.factor });
    if (event.kind === 'resume') this.sink?.({ kind: 'resume', atMs: event.atMs });
    // 'interrupt' and 'ignored' are handled by the session itself.
  }

  private maybeBargeIn(): void {
    const decision = this.bargeIn.decideSpeechStart({
      nowMs: this.nowMs,
      speechMs: this.vad.getStats().speechMs,
      echoOnly: false,
    });
    if (decision.interrupt) this.interrupt('vad');
  }

  /** The user turn ended: commit the transcript, think, reply. */
  private async finishUserTurn(): Promise<void> {
    const turn = this.transcript.commit({ atMs: this.nowMs, speakerId: 'user' });
    if (turn) {
      this.stats.turns += 1;
      this.stats.userTurns += 1;
      this.sink?.({ kind: 'turn', atMs: this.nowMs, turn });
    }
    this.setStatus('processing');
    await this.runModelReply();
  }

  /** Stream the scripted mock reply word by word, running scripted tool calls. */
  private async runModelReply(override?: string): Promise<void> {
    const replyIndex = this.replyIndex;
    const reply = override ?? this.mockReplies[Math.min(replyIndex, this.mockReplies.length - 1)]!;
    if (override === undefined) this.replyIndex += 1;
    const words = reply.split(/\s+/).filter((w) => w.length > 0);
    this.currentReplyWords = words;
    this.setStatus('speaking');
    this.bargeIn.beginThinking();
    const totalMs = Math.max(words.length * this.mockWordMs, 1);
    this.bargeIn.beginSpeaking(splitWordsV9(reply, totalMs));
    const scripted = this.mockToolCalls[replyIndex] ?? [];
    let spoken = '';
    for (let i = 0; i < words.length; i += 1) {
      // A barge-in during the loop stops the stream immediately.
      if (this.status !== 'speaking') return;
      const word = words[i]!;
      spoken = spoken.length === 0 ? word : `${spoken} ${word}`;
      this.transcript.pushPartial(spoken, { speakerId: 'agent', atMs: this.nowMs });
      this.stats.partials += 1;
      this.sink?.({ kind: 'partial', atMs: this.nowMs, speakerId: 'agent', text: spoken });
      this.bargeIn.advancePlayed(this.mockWordMs);
      this.tick(this.mockWordMs);
      const due = scripted.filter((c) => (c.afterWord ?? 0) === i);
      for (const call of due) {
        await this.invokeToolDuringSpeech(call.name, call.args);
        if (this.status !== 'speaking') return;
      }
      // Yield to the event loop so a concurrent interrupt() lands.
      await Promise.resolve();
    }
    const turn = this.transcript.commit({ atMs: this.nowMs, speakerId: 'agent' });
    if (turn) {
      this.stats.turns += 1;
      this.stats.agentTurns += 1;
      this.sink?.({ kind: 'turn', atMs: this.nowMs, turn });
    }
    this.bargeIn.finishSpeaking();
    this.currentReplyWords = [];
    this.setStatus('listening');
  }
}

/** Create a mock v9 session (the manager and the tools use this). */
export function createMockVoiceSessionV9(
  options: VoiceSessionV9Options,
  sink: VoiceSessionV9EventSink | null = null,
): RealtimeVoiceSessionV9 {
  return new RealtimeVoiceSessionV9(options, sink);
}

/** Manager options. */
export interface VoiceV9ManagerOptions {
  /** Default tool handler bound to every session the manager creates. */
  toolHandler?: VoiceV9ToolHandler;
}

/**
 * In-memory registry of v9 sessions. Everything is local: sessions
 * run on the mock model unless the host wires a live transport;
 * no key is ever read here.
 */
export class VoiceV9Manager {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV9>();
  private readonly toolHandler?: VoiceV9ToolHandler;

  constructor(options: VoiceV9ManagerOptions = {}) {
    this.toolHandler = options.toolHandler;
  }

  create(options: VoiceSessionV9Options & { connectNow?: boolean }): RealtimeVoiceSessionV9 {
    if (this.sessions.has(options.sessionId)) {
      throw new Error(`Voice v9 session "${options.sessionId}" already exists.`);
    }
    const session = new RealtimeVoiceSessionV9(
      { ...options, toolHandler: options.toolHandler ?? this.toolHandler },
      null,
    );
    this.sessions.set(options.sessionId, session);
    if (options.connectNow) session.connect();
    return session;
  }

  get(sessionId: string): RealtimeVoiceSessionV9 | undefined {
    return this.sessions.get(sessionId);
  }

  list(): RealtimeVoiceSessionV9[] {
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
