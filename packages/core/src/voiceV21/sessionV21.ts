/**
 * Realtime session v21 (voice v21, v1.34 Team T5).
 *
 * The orchestrator that wires the subsystem together into one
 * realtime session:
 *
 *   transcript ──► turn-taking ──► intent ──► tool call ──► TTS
 *        ▲              │  (barge-in cuts the TTS)           │
 *        └──────────────┴────────────────────────────────────┘
 *
 * The host drives it with three inputs — a final transcript
 * line, a partial transcript update, or a barge-in burst — and
 * reads the outputs as events plus the monitor-panel snapshot.
 * The STT and the model are injected as functions so tests can
 * drive the session with scripted replies and the product can
 * bind real providers later; the defaults are deterministic
 * mocks (STT echoes the scripted text, the model answers from
 * a small script table, falling back to echoing the intent).
 *
 * Flow for one user turn:
 *
 *   1. Partial transcripts update the live line on the panel.
 *   2. A final transcript closes the user turn, is parsed into
 *      an intent, and — while a confirmation is pending — is
 *      first offered as the answer to that confirmation.
 *   3. A tool intent either runs at once (read tools) or parks
 *      in `confirming` and the session speaks the confirmation
 *      prompt. A spoken yes runs it; a spoken no declines it.
 *   4. The result (or a plain chat reply) is spoken through the
 *      streaming TTS cache, chunk by chunk.
 *   5. A barge-in burst while speaking stops the TTS, cuts the
 *      reply, keeps the half-heard transcript, and returns to
 *      listening — the user's new words become the next turn.
 *
 * Every stage records a latency sample (VAD/STT/intent/model/
 * tool/TTS) on the virtual clock the caller passes in, so the
 * eval and the panel report real per-turn numbers.
 */
import {
  round2V21,
  type VoiceV21Event,
  type VoiceV21EventKind,
  type VoiceV21EventSink,
  type VoiceV21Intent,
  type VoiceV21LatencySample,
  type VoiceV21LatencyStage,
  type VoiceV21ToolCallRecord,
  type VoiceV21TurnState,
} from './types';
import {
  parseVoiceIntentV21,
  defaultVoiceToolDescriptorsV21,
} from './intentParserV21';
import {
  VoiceToolCallEngineV21,
  createVoiceToolCallEngineV21,
  type VoiceV21ToolCallEngineOptions,
} from './voiceToolCallV21';
import {
  TurnTakingMachineV21,
  createTurnTakingMachineV21,
  type VoiceV21TurnTakingOptions,
} from './turnTakingV21';
import {
  BargeInEngineV21,
  createBargeInEngineV21,
  type VoiceV21BargeInCandidate,
  type VoiceV21BargeInDecision,
  type VoiceV21ReplyCut,
} from './bargeInV21';
import {
  TtsCacheV21,
  createTtsCacheV21,
  splitTtsTextV21,
  type VoiceV21TtsCacheOptions,
  type VoiceV21TtsSynthesizer,
} from './ttsCacheV21';
import {
  MonitorPanelV21,
  createMonitorPanelV21,
  type VoiceV21MonitorSnapshot,
  type VoiceV21MonitorPanelOptions,
} from './monitorPanelV21';

/** A model reply: text to speak, plus optional tool intent override. */
export type VoiceV21ModelReply = (transcript: string, intent: VoiceV21Intent) => Promise<string>;

export interface VoiceV21SessionOptions {
  turnTaking?: Partial<VoiceV21TurnTakingOptions>;
  toolCall?: Partial<VoiceV21ToolCallEngineOptions>;
  bargeIn?: Parameters<typeof createBargeInEngineV21>[1];
  ttsCache?: Partial<VoiceV21TtsCacheOptions>;
  panel?: Partial<VoiceV21MonitorPanelOptions>;
  /** Voice id for the TTS cache (default 'voice-v21-default'). */
  voiceId?: string;
  /** Scripted model replies, matched by normalised transcript. */
  scriptedReplies?: Record<string, string>;
  /** Model function (default: scripted/echo mock). */
  modelReply?: VoiceV21ModelReply;
  /** TTS synthesiser (default: mock synthesiser). */
  synthesizer?: VoiceV21TtsSynthesizer;
  /** Virtual clock start, ms (default 0). */
  startMs?: number;
}

export interface VoiceV21SessionStats {
  turns: number;
  toolCalls: number;
  toolSucceeded: number;
  bargeIns: number;
  ttsChunksSpoken: number;
  meanResponseLatencyMs: number;
  cacheHitRate: number;
}

export class VoiceSessionV21 {
  readonly sessionId: string;
  readonly turns: TurnTakingMachineV21;
  readonly toolCalls: VoiceToolCallEngineV21;
  readonly bargeIn: BargeInEngineV21;
  readonly tts: TtsCacheV21;
  readonly panel: MonitorPanelV21;
  private readonly opts: VoiceV21SessionOptions;
  private readonly sink?: VoiceV21EventSink;
  private readonly events: VoiceV21Event[] = [];
  private readonly latency: VoiceV21LatencySample[] = [];
  private readonly voiceId: string;
  private clockMs: number;
  private turnCounter = 0;
  private currentReply = '';
  private currentReplySpokenChars = 0;
  private ttsChunksSpoken = 0;
  private speaking = false;
  private closed = false;

  constructor(sessionId: string, opts: VoiceV21SessionOptions = {}, sink?: VoiceV21EventSink) {
    this.sessionId = sessionId;
    this.opts = opts;
    this.voiceId = opts.voiceId ?? 'voice-v21-default';
    this.clockMs = opts.startMs ?? 0;
    const fanout: VoiceV21EventSink = (e) => {
      this.events.push(e);
      sink?.(e);
    };
    this.sink = fanout;
    this.turns = createTurnTakingMachineV21(sessionId, opts.turnTaking, fanout);
    this.toolCalls = createVoiceToolCallEngineV21(sessionId, opts.toolCall, fanout);
    this.bargeIn = createBargeInEngineV21(sessionId, opts.bargeIn, fanout);
    this.tts = createTtsCacheV21(sessionId, opts.ttsCache, opts.synthesizer, fanout);
    this.panel = createMonitorPanelV21(sessionId, opts.panel);
    this.panel.setTurnState('idle', this.clockMs);
  }

  nowMs(): number {
    return this.clockMs;
  }

  /** Advance the virtual clock (tests drive time explicitly). */
  advance(ms: number): void {
    this.clockMs += Math.max(0, ms);
    this.turns.checkWaitingTimeout(this.clockMs);
    this.toolCalls.expirePending(this.clockMs);
  }

  state(): VoiceV21TurnState {
    return this.turns.currentState();
  }

  eventLog(): VoiceV21Event[] {
    return [...this.events];
  }

  eventsOf(kind: VoiceV21EventKind): VoiceV21Event[] {
    return this.events.filter((e) => e.kind === kind);
  }

  latencySamples(): VoiceV21LatencySample[] {
    return [...this.latency];
  }

  private recordLatency(stage: VoiceV21LatencyStage, turnId: string, durationMs: number, atMs: number): void {
    const sample: VoiceV21LatencySample = { stage, turnId, durationMs: round2V21(durationMs), atMs };
    this.latency.push(sample);
    this.panel.recordLatency(sample);
  }

  private newTurnId(): string {
    return `v21-turn-${++this.turnCounter}`;
  }

  /** Open the session: idle → listening. */
  start(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (this.turns.currentState() === 'idle') {
      this.turns.setListening(t);
    }
    this.panel.setTurnState('listening', t);
  }

  /** Partial transcript update (live line on the panel). */
  async feedPartial(text: string, atMs?: number): Promise<void> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const turn = this.turns.currentTurnRecord();
    const turnId = turn?.id ?? this.newTurnId();
    this.bargeIn.keeper.add(turnId, text, t);
    this.panel.setLivePartial(text, t);
    this.sink?.({ kind: 'transcript', atMs: t, sessionId: this.sessionId, detail: { text, status: 'partial', turnId } });
  }

  /**
   * One final transcript line: closes the user turn, parses the
   * intent, runs (or confirms) the tool call, and speaks the
   * reply. Returns the tool-call record when one was created.
   */
  async feedFinal(text: string, atMs?: number): Promise<VoiceV21ToolCallRecord | null> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (this.closed) return null;
    const turnId = this.newTurnId();
    if (this.turns.currentState() === 'idle') this.turns.handle('user-speech-start', t);
    else if (this.turns.currentState() === 'listening') this.turns.handle('user-speech-start', t);
    else if (this.turns.currentState() === 'speaking') this.turns.handle('user-speech-start', t);
    this.bargeIn.keeper.finalise(turnId, text, t);
    this.panel.addFinalTranscript(text, t);
    this.sink?.({ kind: 'transcript', atMs: t, sessionId: this.sessionId, detail: { text, status: 'final', turnId } });
    this.recordLatency('stt', turnId, 120, t);
    this.recordLatency('vad', turnId, 20, t);
    this.turns.handle('user-speech-end', t, { text });
    this.panel.setTurnState(this.turns.currentState(), t);

    const intent = parseVoiceIntentV21(text, this.toolCalls.descriptors());
    this.recordLatency('intent', turnId, 5, t);
    this.sink?.({ kind: 'intent', atMs: t, sessionId: this.sessionId, detail: { toolName: intent.toolName, confidence: intent.confidence } });

    // A pending confirmation eats this turn: yes/no, nothing else.
    const confirmation = await this.toolCalls.handleConfirmationIntent(intent, t);
    if (confirmation.action === 'confirmed' || confirmation.action === 'declined') {
      const record = confirmation.record;
      this.turns.handle('confirm-resolved', t);
      if (record !== null) this.panel.setToolCall(record, t);
      const reply = confirmation.action === 'confirmed'
        ? (record?.resultText ?? 'Done.')
        : 'Cancelled.';
      await this.speak(reply, turnId, t, record?.id);
      return record;
    }

    let record: VoiceV21ToolCallRecord | null = null;
    if (intent.toolName !== '') {
      record = await this.toolCalls.request(intent, turnId, t);
      this.recordLatency('tool', turnId, 80, t);
      if (record !== null && record.status !== 'pending-confirmation') {
        this.panel.setToolCall(record, t);
      }
    }
    if (record !== null && record.status === 'pending-confirmation') {
      this.turns.handle('confirm-requested', t);
      this.panel.setTurnState('confirming', t);
      this.panel.setToolCall(record, t);
      await this.speak(this.toolCalls.confirmationPrompt(record), turnId, t, record.id);
      return record;
    }

    const reply = await this.modelReply(text, intent, record, t);
    this.recordLatency('model', turnId, 200, t);
    await this.speak(reply, turnId, t, record?.id);
    return record;
  }

  private async modelReply(
    transcript: string,
    intent: VoiceV21Intent,
    record: VoiceV21ToolCallRecord | null,
    atMs: number,
  ): Promise<string> {
    if (this.opts.modelReply !== undefined) return this.opts.modelReply(transcript, intent);
    if (record !== null) return record.resultText ?? 'Done.';
    const normalised = transcript.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
    const scripted = this.opts.scriptedReplies ?? {};
    for (const [key, reply] of Object.entries(scripted)) {
      if (normalised.includes(key.toLowerCase())) return reply;
    }
    void atMs;
    return `I heard: ${transcript}`;
  }

  /**
   * Speak text through the streaming TTS cache. Chunks stream
   * out as they arrive; the turn machine tracks speaking until
   * the stream ends (or a barge-in cuts it).
   */
  async speak(text: string, turnId: string, atMs?: number, toolCallId?: string): Promise<void> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    if (text.trim() === '') return;
    this.currentReply = text;
    this.currentReplySpokenChars = 0;
    this.turns.handle('agent-speak-start', t, { text, toolCallId });
    this.panel.setTurnState('speaking', t);
    this.speaking = true;
    this.sink?.({ kind: 'tts-start', atMs: t, sessionId: this.sessionId, detail: { text, turnId } });
    const gen = this.tts.speak(text, this.voiceId, t);
    const totalChunks = Math.max(1, splitTtsTextV21(text, 120).length);
    let chunkIndex = 0;
    while (true) {
      const next = await gen.next();
      if (next.done) break;
      chunkIndex += 1;
      this.ttsChunksSpoken += 1;
      // Spoken progress scales with chunks yielded vs chunks expected.
      this.currentReplySpokenChars = Math.min(text.length, Math.round((chunkIndex / totalChunks) * text.length));
      this.sink?.({ kind: 'tts-chunk', atMs: t, sessionId: this.sessionId, detail: { chunkIndex, bytes: next.value.byteLength } });
      if (!this.speaking) break; // Cut by a barge-in mid-stream.
    }
    if (this.speaking) {
      this.recordLatency('tts', turnId, 60, t);
      this.turns.handle('agent-speak-end', t, { text });
      this.panel.setTurnState(this.turns.currentState(), t);
      this.sink?.({ kind: 'tts-end', atMs: t, sessionId: this.sessionId, detail: { turnId, chunks: chunkIndex } });
    }
    this.speaking = false;
    this.syncPanelCache(t);
  }

  private syncPanelCache(atMs: number): void {
    const s = this.tts.stats();
    this.panel.setCache(
      { entries: s.entries, bytes: s.bytes, hitRate: s.hitRate, hits: s.hits, misses: s.misses, evictions: s.evictions },
      atMs,
    );
  }

  /**
   * A burst of user audio while the agent speaks. Returns the
   * decision; on `interrupt` the TTS stops, the reply is cut,
   * the half-heard transcript is kept, and the session returns
   * to listening.
   */
  async feedBargeIn(
    candidate: Omit<VoiceV21BargeInCandidate, 'agentSpeaking'>,
    atMs?: number,
  ): Promise<{ decision: VoiceV21BargeInDecision; cut: VoiceV21ReplyCut | null }> {
    const t = atMs ?? this.clockMs;
    this.clockMs = t;
    const { decision } = this.bargeIn.observe({ ...candidate, agentSpeaking: this.speaking });
    this.panel.recordBargeIn(decision, t);
    if (decision !== 'interrupt') return { decision, cut: null };
    const turn = this.turns.currentTurnRecord();
    const turnId = turn?.id ?? this.newTurnId();
    const cut = this.bargeIn.cutReply(this.currentReply, this.currentReplySpokenChars, t, turnId);
    this.speaking = false; // Stops the speak() loop at the next chunk.
    this.turns.handle('barge-in', t, { text: cut.spoken });
    this.panel.setTurnState('listening', t);
    this.panel.setLivePartial(this.bargeIn.keeper.heardSoFar(turnId), t);
    return { decision, cut };
  }

  /** Current monitor-panel snapshot. */
  monitor(atMs?: number): VoiceV21MonitorSnapshot {
    const t = atMs ?? this.clockMs;
    this.syncPanelCache(t);
    return this.panel.snapshot(t);
  }

  stats(): VoiceV21SessionStats {
    const turnStats = this.turns.stats();
    const toolStats = this.toolCalls.stats(this.clockMs);
    return {
      turns: turnStats.turns,
      toolCalls: toolStats.requested,
      toolSucceeded: toolStats.succeeded,
      // The barge-in engine is the authority on interrupts: the
      // turn machine only counts overlaps it observed, and a
      // burst scored by the engine need not have opened one.
      bargeIns: this.bargeIn.stats().interrupted,
      ttsChunksSpoken: this.ttsChunksSpoken,
      meanResponseLatencyMs: turnStats.meanResponseLatencyMs,
      cacheHitRate: this.tts.stats().hitRate,
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice session ${this.sessionId}: state=${this.state()}, turns=${s.turns}, ` +
      `tool calls=${s.toolCalls} (${s.toolSucceeded} ok), barge-ins=${s.bargeIns}, ` +
      `tts chunks=${s.ttsChunksSpoken}, cache hit=${(s.cacheHitRate * 100).toFixed(0)}%`;
  }

  close(atMs?: number): void {
    const t = atMs ?? this.clockMs;
    this.closed = true;
    this.speaking = false;
    this.sink?.({ kind: 'closed', atMs: t, sessionId: this.sessionId });
  }
}

export function createVoiceSessionV21(
  sessionId: string,
  opts: VoiceV21SessionOptions = {},
  sink?: VoiceV21EventSink,
): VoiceSessionV21 {
  return new VoiceSessionV21(sessionId, opts, sink);
}

/** Default scripted replies for the mock model (greetings + help). */
export const VOICE_V21_SCRIPTED_REPLIES: Record<string, string> = {
  'xin chào': 'Xin chào! Tôi có thể giúp gì cho bạn?',
  hello: 'Hello! How can I help?',
  'cảm ơn': 'Không có gì!',
  'thank you': "You're welcome!",
};
