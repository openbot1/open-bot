/**
 * Realtime pipeline v20 (voice v20, v1.28 Team T5).
 *
 * The integration layer the five v20 modules were built for. One
 * pipeline owns one call and wires the stages in order:
 *
 *   capture → jitter buffer → VAD → (speech) → mock STT segments
 *     → transcript reconciler → turn machine → mock reply → prosody
 *     TTS → playback cursor → barge-in engine → (cut) → resume
 *
 * Frames arrive with `feedFrame`; transcript segments arrive with
 * `ingestTranscript`; the mock reply comes from an injected
 * `replyFor` function (tests supply a deterministic one, the real
 * app would supply a model call). Playback is virtual: the test or
 * the app calls `playNextChunk()` / `advancePlayback()` and the
 * pipeline moves the spoken-char cursor, so barge-in cut points are
 * reproducible without a sound card or a clock.
 *
 * The pipeline also owns the per-call event log, the eval collector
 * feed, provider failover hooks and the reconnect manager hooks —
 * all optional, all mock. No network, no key, no live media.
 */
import { AdaptiveVadV20, type VadV20Options } from './vadV20';
import { JitterBufferV20, type JitterBufferV20Options } from './jitterBufferV20';
import { TranscriptReconcilerV20, type TranscriptV20Options } from './transcriptV20';
import { BargeInEngineV20, type BargeInV20Options, type BargeInV20ResumeMode } from './bargeInV20';
import { ProsodyTtsV20, type TtsV20Chunk, type TtsV20Options } from './ttsProsodyV20';
import { VoiceEvalV20 } from './metricsV20';
import { ReconnectManagerV20, makeVoiceV20Error, type VoiceV20ErrorKind } from './reconnectV20';
import { ProviderRegistryV20 } from './providersV20';
import {
  silentFrameV20,
  type VoiceV20Event,
  type VoiceV20EventSink,
  type VoiceV20Frame,
  type VoiceV20TranscriptSegment,
  type VoiceV20TurnRecord,
} from './types';

export type PipelineV20Phase =
  | 'idle'
  | 'listening'
  | 'user-speaking'
  | 'thinking'
  | 'agent-speaking'
  | 'ended';

export interface PipelineV20Options {
  vad: Partial<VadV20Options>;
  jitter: Partial<JitterBufferV20Options>;
  transcript: Partial<TranscriptV20Options>;
  bargeIn: Partial<BargeInV20Options>;
  tts: Partial<TtsV20Options>;
  /** Max turns kept in the call history. */
  maxTurns: number;
  /** Max events kept in the event log. */
  maxEvents: number;
  /** Silence (ms) after speech-end before the turn is finalised. */
  turnFinalizeDelayMs: number;
}

export function defaultPipelineV20Options(): PipelineV20Options {
  return {
    vad: {},
    jitter: {},
    transcript: {},
    bargeIn: {},
    tts: {},
    maxTurns: 100,
    maxEvents: 500,
    turnFinalizeDelayMs: 150,
  };
}

export function validatePipelineV20Options(o: Partial<PipelineV20Options>): string[] {
  const e: string[] = [];
  if (o.maxTurns !== undefined && o.maxTurns < 1) e.push('maxTurns must be >= 1');
  if (o.maxEvents !== undefined && o.maxEvents < 1) e.push('maxEvents must be >= 1');
  if (o.turnFinalizeDelayMs !== undefined && o.turnFinalizeDelayMs < 0) e.push('turnFinalizeDelayMs must be >= 0');
  return e;
}

export interface PipelineV20Hooks {
  /** Mock model reply for a final user turn. Defaults to an echo reply. */
  replyFor?: (userText: string, turnId: string) => string;
  /** Called when a user turn is finalised (committed transcript). */
  onUserTurn?: (turn: VoiceV20TurnRecord) => void;
  /** Called when an agent turn finishes speaking (or is cut). */
  onAgentTurn?: (turn: VoiceV20TurnRecord) => void;
}

export interface PipelineV20Stats {
  phase: PipelineV20Phase;
  frames: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  cuts: number;
  ttsChunksPlayed: number;
  ttsCharsSpoken: number;
  events: number;
}

export interface PipelineV20Snapshot {
  phase: PipelineV20Phase;
  turnCounter: number;
  turns: VoiceV20TurnRecord[];
  committedTranscript: string;
  stats: PipelineV20Stats;
}

/**
 * One realtime call. Virtual clock: every method takes `nowMs`
 * explicitly; nothing reads Date.now() except the transcript
 * pruner inside the reconciler (bounded, non-timing).
 */
export class VoicePipelineV20 {
  readonly sessionId: string;
  private opts: PipelineV20Options;
  private hooks: PipelineV20Hooks;
  private sink?: VoiceV20EventSink;
  private vad: AdaptiveVadV20;
  private jitter: JitterBufferV20;
  private transcript: TranscriptReconcilerV20;
  private bargeIn: BargeInEngineV20;
  private tts: ProsodyTtsV20;
  private eval: VoiceEvalV20;
  private registry?: ProviderRegistryV20;
  private reconnect?: ReconnectManagerV20;
  private phase: PipelineV20Phase = 'idle';
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private turnStartedAtMs = 0;
  /** True while the VAD believes the user is mid-utterance (independent of phase). */
  private userTurnActive = false;
  /** True when the user started speaking while the agent was speaking. */
  private userInterrupting = false;
  private speechEndAtMs: number | null = null;
  /** Last speech-end, kept for turn-latency measurement after finalise. */
  private lastSpeechEndAtMs: number | null = null;
  private pendingUserText: string | null = null;
  private agentChunks: TtsV20Chunk[] = [];
  private agentChunkIdx = 0;
  private agentTurnId: string | null = null;
  private agentReplyText = '';
  private spokenChars = 0;
  private turns: VoiceV20TurnRecord[] = [];
  private events: VoiceV20Event[] = [];
  private stats = {
    frames: 0, userTurns: 0, agentTurns: 0, cuts: 0,
    ttsChunksPlayed: 0, ttsCharsSpoken: 0,
  };

  constructor(
    sessionId: string,
    opts: Partial<PipelineV20Options> = {},
    hooks: PipelineV20Hooks = {},
    sink?: VoiceV20EventSink,
    deps: { registry?: ProviderRegistryV20; reconnect?: ReconnectManagerV20 } = {},
  ) {
    this.sessionId = sessionId;
    this.opts = { ...defaultPipelineV20Options(), ...opts };
    this.hooks = hooks;
    this.sink = sink;
    this.registry = deps.registry;
    this.reconnect = deps.reconnect;
    this.vad = new AdaptiveVadV20(this.opts.vad, (e) => this.onVadEvent(e));
    this.jitter = new JitterBufferV20(this.opts.jitter);
    this.transcript = new TranscriptReconcilerV20(this.opts.transcript, (e) => {
      this.emit({ kind: 'transcript', atMs: 0, detail: { event: e.kind } });
    });
    this.bargeIn = new BargeInEngineV20(this.opts.bargeIn, (e) => {
      this.emit({ kind: 'barge-in', atMs: 0, detail: { event: e.kind } });
    });
    this.tts = new ProsodyTtsV20(this.opts.tts);
    this.eval = new VoiceEvalV20();
  }

  get currentPhase(): PipelineV20Phase { return this.phase; }
  get evaluator(): VoiceEvalV20 { return this.eval; }
  get transcriptReconciler(): TranscriptReconcilerV20 { return this.transcript; }
  get bargeInEngine(): BargeInEngineV20 { return this.bargeIn; }
  get jitterBuffer(): JitterBufferV20 { return this.jitter; }
  get vadEngine(): AdaptiveVadV20 { return this.vad; }

  start(atMs: number): void {
    if (this.phase !== 'idle' && this.phase !== 'ended') return;
    this.phase = 'listening';
    this.reconnect?.connect(atMs);
    this.reconnect?.connected(atMs);
    this.emit({ kind: 'frame', atMs, detail: { phase: 'listening' } });
  }

  end(atMs: number): void {
    this.phase = 'ended';
    this.bargeIn.agentStop();
    this.emit({ kind: 'closed', atMs, detail: { turns: this.turns.length } });
  }

  private emit(e: VoiceV20Event): void {
    const full: VoiceV20Event = { ...e, sessionId: this.sessionId };
    this.events.push(full);
    if (this.events.length > this.opts.maxEvents) this.events.shift();
    this.sink?.(full);
  }

  getEvents(): VoiceV20Event[] { return [...this.events]; }
  getTurns(): VoiceV20TurnRecord[] { return [...this.turns]; }

  /** Feed one captured frame. Drives jitter → VAD → barge-in. */
  feedFrame(frame: VoiceV20Frame, nowMs: number): void {
    if (this.phase === 'idle' || this.phase === 'ended') return;
    this.stats.frames += 1;
    this.jitter.push(frame);
    const released = this.jitter.popDue(nowMs);
    for (const rel of released) {
      this.vad.feed(rel.frame);
      if (this.phase === 'agent-speaking' || this.bargeIn.isAgentSpeaking) {
        const decision = this.bargeIn.feed(rel.frame);
        if (decision === 'cut') this.onBargeInCut(nowMs);
      }
    }
    // Turn finalisation: speech ended a while ago and no agent speech is running.
    if (this.speechEndAtMs !== null && this.phase === 'user-speaking'
      && nowMs - this.speechEndAtMs >= this.opts.turnFinalizeDelayMs) {
      this.finalizeUserTurn(nowMs);
    }
  }

  private onVadEvent(e: { kind: string; atMs: number; detail?: Record<string, unknown> }): void {
    if (e.kind === 'speech-start') {
      if (this.userTurnActive) return;
      this.userTurnActive = true;
      this.turnCounter += 1;
      this.currentTurnId = `turn-${this.turnCounter}`;
      this.turnStartedAtMs = e.atMs;
      this.speechEndAtMs = null;
      if (this.phase === 'listening') {
        this.phase = 'user-speaking';
      } else if (this.phase === 'agent-speaking') {
        // User started talking over the agent: do NOT flip the
        // phase — the barge-in engine (fed in parallel) decides
        // whether this is a cut. The turn is tracked meanwhile.
        this.userInterrupting = true;
      }
      this.emit({ kind: 'speech-start', atMs: e.atMs, detail: { turnId: this.currentTurnId, interrupting: this.userInterrupting } });
    } else if (e.kind === 'speech-end') {
      if (!this.userTurnActive) return;
      this.userTurnActive = false;
      this.speechEndAtMs = e.atMs;
      this.emit({ kind: 'speech-end', atMs: e.atMs, detail: { turnId: this.currentTurnId, speechMs: e.detail?.speechMs ?? null } });
    } else if (e.kind === 'speaker-change') {
      this.transcript.noteSpeakerChange(e.atMs, 'user-2');
      this.emit({ kind: 'speech-start', atMs: e.atMs, detail: { speakerChange: true } });
    }
  }

  /** Feed one mock STT segment (partial / final / corrected). */
  ingestTranscript(segment: VoiceV20TranscriptSegment): void {
    if (this.phase === 'idle' || this.phase === 'ended') return;
    if (this.currentTurnId && segment.turnId === '') segment = { ...segment, turnId: this.currentTurnId };
    const committed = this.transcript.ingest(segment);
    if (committed) {
      this.pendingUserText = committed.text;
      this.emit({ kind: 'transcript', atMs: segment.atMs, detail: { id: committed.id, status: committed.status, text: committed.text } });
    } else {
      this.emit({ kind: 'transcript', atMs: segment.atMs, detail: { id: segment.id, status: segment.status } });
    }
  }

  /**
   * Advance the virtual clock without new audio (lets the jitter
   * buffer drain, the VAD hangover expire, and the turn finalise).
   * Feeds silence frames through the pipeline.
   */
  tick(nowMs: number, frames = 1): void {
    if (this.phase === 'idle' || this.phase === 'ended') return;
    let seq = this.jitter.nextExpectedSeq ?? 0;
    for (let i = 0; i < frames; i += 1) {
      const frame = silentFrameV20(seq + i, nowMs + i * 20);
      this.feedFrame(frame, nowMs + i * 20);
    }
    // If speech ended but the VAD hangover has not fired yet, the
    // silence above will have driven it; finalise if due.
    if (this.speechEndAtMs !== null && this.phase === 'user-speaking'
      && nowMs - this.speechEndAtMs >= this.opts.turnFinalizeDelayMs) {
      this.finalizeUserTurn(nowMs);
    }
  }

  private finalizeUserTurn(nowMs: number): void {
    const turnId = this.currentTurnId ?? `turn-${this.turnCounter + 1}`;
    const text = this.pendingUserText ?? this.transcript.liveView().text;
    const record: VoiceV20TurnRecord = {
      id: turnId,
      role: 'user',
      text,
      atMs: this.turnStartedAtMs,
      durationMs: Math.max(0, nowMs - this.turnStartedAtMs),
    };
    this.turns.push(record);
    this.stats.userTurns += 1;
    this.hooks.onUserTurn?.(record);
    this.lastSpeechEndAtMs = this.speechEndAtMs;
    this.speechEndAtMs = null;
    this.pendingUserText = null;
    this.userInterrupting = false;
    this.phase = 'thinking';
    this.emit({ kind: 'turn-end', atMs: nowMs, detail: { turnId, role: 'user', text } });
    this.startAgentReply(text, turnId, nowMs);
  }

  private startAgentReply(userText: string, userTurnId: string, nowMs: number): void {
    const reply = this.hooks.replyFor ? this.hooks.replyFor(userText, userTurnId) : `Bạn vừa nói: ${userText}`;
    this.agentReplyText = reply;
    this.agentChunks = this.tts.plan(reply);
    this.agentChunkIdx = 0;
    this.spokenChars = 0;
    this.turnCounter += 1;
    this.agentTurnId = `turn-${this.turnCounter}`;
    this.bargeIn.agentStart(reply, this.agentTurnId, nowMs);
    this.phase = 'agent-speaking';
    this.emit({ kind: 'tts-start', atMs: nowMs, detail: { turnId: this.agentTurnId, chunks: this.agentChunks.length, reply } });
  }

  /**
   * Play (virtually) the next TTS chunk: advances the spoken-char
   * cursor and the barge-in engine. Returns the chunk, or null when
   * the reply is finished (which closes the agent turn).
   */
  playNextChunk(nowMs: number): TtsV20Chunk | null {
    if (this.phase !== 'agent-speaking') return null;
    const chunk = this.agentChunks[this.agentChunkIdx];
    if (!chunk) {
      this.finishAgentTurn(nowMs, false);
      return null;
    }
    this.agentChunkIdx += 1;
    if (chunk.kind === 'speech') {
      this.spokenChars += chunk.text.length;
      this.bargeIn.advanceSpoken(chunk.text.length);
      this.stats.ttsChunksPlayed += 1;
      this.stats.ttsCharsSpoken += chunk.text.length;
    }
    this.emit({ kind: 'tts-chunk', atMs: nowMs, detail: { id: chunk.id, kind: chunk.kind, estMs: chunk.estDurationMs } });
    if (this.lastSpeechEndAtMs !== null) {
      // Record turn latency: speech-end → first agent chunk.
      this.eval.noteTurnLatency(this.agentTurnId ?? '', this.lastSpeechEndAtMs, nowMs);
      this.lastSpeechEndAtMs = null;
    }
    if (this.agentChunkIdx >= this.agentChunks.length) {
      this.finishAgentTurn(nowMs, false);
    }
    return chunk;
  }

  /** Play all remaining chunks at once (virtual fast-forward). */
  playAllChunks(nowMs: number): TtsV20Chunk[] {
    const played: TtsV20Chunk[] = [];
    let chunk: TtsV20Chunk | null;
    while ((chunk = this.playNextChunk(nowMs)) !== null) played.push(chunk);
    return played;
  }

  private onBargeInCut(nowMs: number): void {
    const cut = this.bargeIn.lastCut;
    this.stats.cuts += 1;
    // The user's words so far become the cut's prefix.
    const live = this.transcript.liveView().text;
    if (cut) this.bargeIn.attachUserPrefix(cut.atMs, live);
    this.eval.noteBargeIn({ atMs: nowMs, decision: 'cut', truth: 'interruption' });
    const record: VoiceV20TurnRecord = {
      id: this.agentTurnId ?? 'unknown',
      role: 'agent',
      text: this.agentReplyText,
      atMs: nowMs,
      durationMs: 0,
      bargeInCut: true,
    };
    this.turns.push(record);
    this.stats.agentTurns += 1;
    this.hooks.onAgentTurn?.(record);
    this.agentChunks = [];
    this.agentChunkIdx = 0;
    // The user is mid-utterance: the cut hands the floor to them.
    this.phase = this.userTurnActive ? 'user-speaking' : 'listening';
    this.userInterrupting = false;
    this.emit({ kind: 'barge-in', atMs: nowMs, detail: { turnId: record.id, remaining: cut?.remainingText ?? '' } });
    this.emit({ kind: 'tts-end', atMs: nowMs, detail: { turnId: record.id, cut: true } });
  }

  private finishAgentTurn(nowMs: number, cut: boolean): void {
    const record: VoiceV20TurnRecord = {
      id: this.agentTurnId ?? 'unknown',
      role: 'agent',
      text: this.agentReplyText,
      atMs: nowMs,
      durationMs: 0,
      bargeInCut: cut,
    };
    this.turns.push(record);
    this.stats.agentTurns += 1;
    this.hooks.onAgentTurn?.(record);
    this.bargeIn.agentStop();
    this.agentChunks = [];
    this.agentChunkIdx = 0;
    this.phase = 'listening';
    this.emit({ kind: 'tts-end', atMs: nowMs, detail: { turnId: record.id, cut } });
    this.emit({ kind: 'turn-end', atMs: nowMs, detail: { turnId: record.id, role: 'agent' } });
    // A user turn that ended while the agent was speaking (no cut:
    // a short remark, not an interruption) is answered now.
    if (this.speechEndAtMs !== null && !this.userTurnActive
      && nowMs - this.speechEndAtMs >= this.opts.turnFinalizeDelayMs) {
      this.phase = 'user-speaking';
      this.finalizeUserTurn(nowMs);
    }
  }

  /** How the cut reply continues: resume / restart / drop. Returns the text to speak next. */
  resumeAfterCut(mode: BargeInV20ResumeMode, nowMs: number): string {
    const text = this.bargeIn.chooseResume(mode, nowMs);
    if (text === '') {
      this.phase = 'listening';
      return '';
    }
    this.agentReplyText = text;
    this.agentChunks = this.tts.plan(text);
    this.agentChunkIdx = 0;
    this.spokenChars = 0;
    this.turnCounter += 1;
    this.agentTurnId = `turn-${this.turnCounter}`;
    this.bargeIn.agentStart(text, this.agentTurnId, nowMs);
    this.phase = 'agent-speaking';
    this.emit({ kind: 'tts-start', atMs: nowMs, detail: { turnId: this.agentTurnId, mode, chunks: this.agentChunks.length } });
    return text;
  }

  /**
   * Report a provider-side failure into the reconnect manager (if
   * one was attached). Returns the action the caller should take.
   */
  reportProviderFailure(kind: VoiceV20ErrorKind, message: string, atMs: number, attempt = 0): string {
    if (!this.reconnect) return 'abort';
    const err = makeVoiceV20Error(kind, message, atMs, attempt);
    const { action } = this.reconnect.handleError(err);
    this.emit({ kind: 'failover', atMs, detail: { errorKind: kind, action } });
    return action;
  }

  /** Feed one health window into the eval collector. */
  noteHealthWindow(nowMs: number): void {
    const j = this.jitter.getStats();
    const b = this.bargeIn.getStats();
    this.eval.noteHealthWindow({
      atMs: nowMs,
      released: j.released,
      concealed: j.concealedFrames,
      gaps: j.gaps,
      cuts: b.cuts,
      errors: this.reconnect ? this.reconnect.getStats().errors : 0,
    });
  }

  getStats(): PipelineV20Stats {
    return {
      phase: this.phase,
      frames: this.stats.frames,
      turns: this.turns.length,
      userTurns: this.stats.userTurns,
      agentTurns: this.stats.agentTurns,
      cuts: this.stats.cuts,
      ttsChunksPlayed: this.stats.ttsChunksPlayed,
      ttsCharsSpoken: this.stats.ttsCharsSpoken,
      events: this.events.length,
    };
  }

  snapshot(): PipelineV20Snapshot {
    return {
      phase: this.phase,
      turnCounter: this.turnCounter,
      turns: this.getTurns(),
      committedTranscript: this.transcript.fullText(),
      stats: this.getStats(),
    };
  }

  /** Restore a pipeline from a snapshot (session recovery). */
  restore(snap: PipelineV20Snapshot, atMs: number): void {
    this.phase = snap.phase === 'ended' ? 'ended' : 'listening';
    this.turnCounter = snap.turnCounter;
    this.turns = snap.turns.map((t) => ({ ...t }));
    this.stats.userTurns = this.turns.filter((t) => t.role === 'user').length;
    this.stats.agentTurns = this.turns.filter((t) => t.role === 'agent').length;
    this.emit({ kind: 'recovered', atMs, detail: { turns: this.turns.length, phase: this.phase } });
  }

  summary(): string {
    const s = this.getStats();
    return `Pipeline v20 (${this.sessionId}): ${s.phase}, ${s.frames} frames, ` +
      `${s.userTurns} user turns, ${s.agentTurns} agent turns, ${s.cuts} cuts, ` +
      `${s.ttsChunksPlayed} TTS chunks, ${s.ttsCharsSpoken} chars spoken`;
  }
}

export function createVoicePipelineV20(
  sessionId: string,
  opts: Partial<PipelineV20Options> = {},
  hooks: PipelineV20Hooks = {},
  sink?: VoiceV20EventSink,
  deps: { registry?: ProviderRegistryV20; reconnect?: ReconnectManagerV20 } = {},
): VoicePipelineV20 {
  return new VoicePipelineV20(sessionId, opts, hooks, sink, deps);
}

export function pipelineV20Markdown(p: VoicePipelineV20): string {
  const s = p.getStats();
  const lines = [
    `# Pipeline v20 (${p.sessionId})`, ``,
    `- Phase: ${s.phase}`, `- Frames: ${s.frames}`, `- Turns: ${s.turns}`,
    `- User turns: ${s.userTurns}`, `- Agent turns: ${s.agentTurns}`,
    `- Barge-in cuts: ${s.cuts}`, `- TTS chunks played: ${s.ttsChunksPlayed}`,
    `- TTS chars spoken: ${s.ttsCharsSpoken}`, `- Events: ${s.events}`, ``,
    `## Eval`, ``,
    p.evaluator.summary(), ``,
  ];
  return lines.join('\n');
}
