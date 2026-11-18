/**
 * Speech-to-speech path v4 (v1.17, Đội T5 — voice v16).
 *
 * v15 proved the fast path exists: one S2S adapter over a mock
 * transport, a reconnect state machine and a pipeline fallback.
 * v16 owns the *complete* path end to end, because a fast path that
 * drops audio, tears a turn in half when the stream drops, or lets
 * the agent talk over a backlog is not a path at all:
 *
 *   mic → STT streaming → agent (streaming reply) → TTS streaming → speaker
 *
 *   1. STT streaming v4 (`StreamingSttV16`): 20 ms PCM16 frames in,
 *      partial transcripts out as words arrive (with per-word
 *      timings), a final transcript when silence ends the turn.
 *      The STT is scripted in tests (a word schedule); a host binds
 *      a real streaming recogniser behind the same interface.
 *   2. Backpressure: every stage boundary is a bounded queue with a
 *      high-water mark (pause intake) and a low-water mark (resume).
 *      Mic frames past a full queue drop *oldest* (live audio must
 *      stay live — a stale frame is worse than a missing one) and
 *      the drop is counted, never silent. Agent reply chunks and
 *      TTS audio chunks have their own queues with the same
 *      discipline, so a slow speaker cannot grow memory without
 *      bound and a slow agent cannot flood the speaker.
 *   3. Reconnect with turn resume: when the S2S stream drops
 *      mid-turn the pipeline snapshots a *resume token* — turn id,
 *      transcript prefix already heard, reply chunks already
 *      spoken, pending function calls — and on reconnect it
 *      re-sends the transcript prefix as context and resumes the
 *      reply from the first unspoken chunk instead of restarting
 *      the turn. A turn survives a drop; it does not replay.
 *   4. Fallback: when the S2S adapter exhausts its reconnect
 *      budget the pipeline keeps the turn on the classic
 *      STT → LLM → TTS stages and records the fallback, exactly
 *      like v15 — the session never sees a crash, only a mode.
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances the S2S adapter, the STT, the agent stream and the
 * speaker together. No network, no sound card, no key.
 */

import {
  S2SAdapterV15,
  MockS2STransportV15,
  createS2SAdapterV15,
  S2S_V15_FRAME_SAMPLES,
} from '../voiceV15/s2sV15';
import type { S2SEventV15, S2SProviderKindV15, MockS2SScriptEventV15 } from '../voiceV15/s2sV15';
import { chunkTtsTextV15, mockTtsSynthV15 } from '../voiceV15/ttsStreamV15';
import type { VoiceProfileV15 } from '../voiceV15/ttsStreamV15';

export const S2S_V16_SAMPLE_RATE_HZ = 24000;
export const S2S_V16_FRAME_MS = 20;
export const S2S_V16_FRAME_SAMPLES = S2S_V15_FRAME_SAMPLES;
export const S2S_V16_DEFAULT_MAX_QUEUED_FRAMES = 150;
export const S2S_V16_DEFAULT_MAX_QUEUED_REPLY_CHUNKS = 32;
export const S2S_V16_DEFAULT_MAX_QUEUED_AUDIO_CHUNKS = 16;

/** One scripted STT word: text + virtual ms after turn start. */
export interface SttWordScheduleV16 {
  word: string;
  atMs: number;
}

export type SttV16EventKind = 'partial' | 'final' | 'word';

export interface SttV16Event {
  kind: SttV16EventKind;
  atMs: number;
  text: string;
  /** Words with timings (final events carry the whole turn). */
  words?: { word: string; atMs: number }[];
}

export type SttV16Sink = (event: SttV16Event) => void;

export interface StreamingSttV16Options {
  /** Scripted words for the current turn (tests / mock). */
  wordSchedule?: SttWordScheduleV16[];
  /** Silence (ms) after the last word before the turn finalises. */
  finalSilenceMs?: number;
}

export function defaultStreamingSttV16Options(): Required<StreamingSttV16Options> {
  return { wordSchedule: [], finalSilenceMs: 400 };
}

export function validateStreamingSttV16Options(options: StreamingSttV16Options): string[] {
  const errors: string[] = [];
  if (options.finalSilenceMs !== undefined && (options.finalSilenceMs < 50 || options.finalSilenceMs > 5000)) {
    errors.push('finalSilenceMs must be 50..5000');
  }
  if (options.wordSchedule !== undefined) {
    for (const word of options.wordSchedule) {
      if (!word.word.trim()) errors.push('wordSchedule entries must not be empty');
      if (word.atMs < 0) errors.push('wordSchedule atMs must be >= 0');
    }
  }
  return errors;
}

/**
 * Mock streaming STT. Frames advance the clock; scripted words
 * fire as partials at their scheduled time; silence after the last
 * word finalises the turn. A host replaces the schedule with a real
 * recogniser and keeps the same event shape.
 */
export class StreamingSttV16 {
  private readonly options: Required<StreamingSttV16Options>;
  private readonly sink: SttV16Sink | undefined;
  private nowMs = 0;
  private turnStartedAtMs = 0;
  private turnActive = false;
  private lastWordAtMs: number | undefined;
  private firedWords = 0;
  private readonly words: { word: string; atMs: number }[] = [];
  private partials = 0;
  private finals = 0;
  private framesConsumed = 0;
  /** Start of the current candidate turn (first frame since the last final). */
  private candidateStartMs: number | undefined;

  constructor(options: StreamingSttV16Options = {}, sink?: SttV16Sink) {
    const merged = { ...defaultStreamingSttV16Options(), ...options };
    const errors = validateStreamingSttV16Options(merged);
    if (errors.length > 0) throw new Error(`invalid streaming STT options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
  }

  /** Start a turn (resets the word schedule cursor). */
  beginTurn(atMs: number): void {
    this.turnStartedAtMs = atMs;
    this.turnActive = true;
    this.lastWordAtMs = undefined;
    this.firedWords = 0;
    this.words.length = 0;
    this.candidateStartMs = undefined;
  }

  setWordSchedule(schedule: SttWordScheduleV16[]): void {
    this.options.wordSchedule = [...schedule].sort((a, b) => a.atMs - b.atMs);
    // A new schedule is a new turn: reset the word cursor so the
    // next speech frames can begin a turn from its first word.
    this.firedWords = 0;
    this.words.length = 0;
    this.candidateStartMs = undefined;
  }

  /**
   * Feed one mic frame; returns the STT event fired, if any. A turn
   * only begins when its first word arrives — silence frames after
   * a final never start a phantom turn that would re-fire the
   * schedule and finalise again.
   */
  feedFrame(_frame: Int16Array, atMs: number): SttV16Event | undefined {
    this.nowMs = atMs;
    this.framesConsumed += 1;
    const schedule = this.options.wordSchedule;
    if (!this.turnActive) {
      if (this.candidateStartMs === undefined) this.candidateStartMs = atMs;
      if (this.firedWords >= schedule.length) return undefined;
      const elapsed = atMs - this.candidateStartMs;
      if (schedule[this.firedWords].atMs > elapsed) return undefined;
      this.beginTurn(this.candidateStartMs);
    }
    const elapsed = atMs - this.turnStartedAtMs;
    while (this.firedWords < schedule.length && schedule[this.firedWords].atMs <= elapsed) {
      const item = schedule[this.firedWords];
      this.firedWords += 1;
      this.words.push({ word: item.word, atMs });
      this.lastWordAtMs = atMs;
      this.partials += 1;
      const event: SttV16Event = {
        kind: 'partial',
        atMs,
        text: this.words.map((w) => w.word).join(' '),
        words: [...this.words],
      };
      this.sink?.(event);
      return event;
    }
    return this.maybeFinalise(atMs);
  }

  /** Feed silence; finalises the turn once the gap is long enough. */
  feedSilence(ms: number, atMs: number): SttV16Event | undefined {
    this.nowMs = atMs;
    if (!this.turnActive) return undefined;
    if (this.lastWordAtMs === undefined) return undefined;
    if (atMs - this.lastWordAtMs < this.options.finalSilenceMs) return undefined;
    void ms;
    return this.finalise(atMs);
  }

  /** Force a final transcript now (caller-driven turn end). */
  forceFinal(atMs: number): SttV16Event | undefined {
    if (!this.turnActive || this.words.length === 0) return undefined;
    return this.finalise(atMs);
  }

  partialText(): string {
    return this.words.map((w) => w.word).join(' ');
  }

  isTurnActive(): boolean {
    return this.turnActive;
  }

  stats(): { partials: number; finals: number; framesConsumed: number; wordsHeard: number } {
    return { partials: this.partials, finals: this.finals, framesConsumed: this.framesConsumed, wordsHeard: this.words.length };
  }

  private maybeFinalise(atMs: number): SttV16Event | undefined {
    if (this.lastWordAtMs === undefined) return undefined;
    if (atMs - this.lastWordAtMs < this.options.finalSilenceMs) return undefined;
    return this.finalise(atMs);
  }

  private finalise(atMs: number): SttV16Event {
    const text = this.partialText();
    this.turnActive = false;
    this.finals += 1;
    const event: SttV16Event = { kind: 'final', atMs, text, words: [...this.words] };
    this.sink?.(event);
    return event;
  }
}

export function createStreamingSttV16(options: StreamingSttV16Options = {}, sink?: SttV16Sink): StreamingSttV16 {
  return new StreamingSttV16(options, sink);
}

/** Backpressure state of one bounded queue. */
export type BackpressureStateV16 = 'flowing' | 'paused' | 'dropping';

export interface BoundedQueueStatsV16 {
  depth: number;
  capacity: number;
  highWater: number;
  lowWater: number;
  dropped: number;
  pauses: number;
  state: BackpressureStateV16;
}

/**
 * Bounded FIFO with high/low-water backpressure. Over capacity the
 * queue drops the *oldest* item (live audio stays live) and reports
 * the drop; intake pauses above high-water and resumes below
 * low-water. Pure data structure — the pipeline owns the policy
 * of what a pause means for each stage.
 */
export class BoundedQueueV16<T> {
  private readonly capacity: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly items: T[] = [];
  private dropped = 0;
  private pauses = 0;
  private paused = false;

  constructor(capacity: number, highWaterRatio = 0.8, lowWaterRatio = 0.4) {
    if (capacity <= 0) throw new Error('bounded queue capacity must be > 0');
    this.capacity = capacity;
    this.highWater = Math.max(1, Math.floor(capacity * highWaterRatio));
    this.lowWater = Math.max(0, Math.floor(capacity * lowWaterRatio));
  }

  push(item: T): { dropped: T | undefined; paused: boolean } {
    let dropped: T | undefined;
    if (this.items.length >= this.capacity) {
      dropped = this.items.shift();
      this.dropped += 1;
    }
    this.items.push(item);
    if (!this.paused && this.items.length >= this.highWater) {
      this.paused = true;
      this.pauses += 1;
    }
    return { dropped, paused: this.paused };
  }

  shift(): T | undefined {
    const item = this.items.shift();
    if (this.paused && this.items.length <= this.lowWater) this.paused = false;
    return item;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  clear(): T[] {
    const rest = [...this.items];
    this.items.length = 0;
    this.paused = false;
    return rest;
  }

  get length(): number {
    return this.items.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  stats(): BoundedQueueStatsV16 {
    return {
      depth: this.items.length,
      capacity: this.capacity,
      highWater: this.highWater,
      lowWater: this.lowWater,
      dropped: this.dropped,
      pauses: this.pauses,
      state: this.dropped > 0 && this.paused ? 'dropping' : this.paused ? 'paused' : 'flowing',
    };
  }
}

/** Resume token: everything needed to continue a turn after a drop. */
export interface S2SResumeTokenV16 {
  turnId: string;
  transcriptPrefix: string;
  /** Reply chunks already spoken (never re-spoken). */
  spokenReplyChunks: number;
  /** Reply chunks still pending when the stream dropped. */
  pendingReplyChunks: string[];
  /** Function calls that arrived but were not answered yet. */
  pendingFunctionCalls: string[];
  droppedAtMs: number;
  reconnectAttempt: number;
}

export type S2SPipelineModeV16 = 's2s' | 'pipeline';
export type S2SPipelineStateV16 = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'fallback' | 'closed';

export type S2SPipelineEventKindV16 =
  | 'state'
  | 'stt-partial'
  | 'stt-final'
  | 'reply-chunk'
  | 'audio'
  | 'backpressure'
  | 'dropped'
  | 'reconnected'
  | 'resumed'
  | 'fallback'
  | 'turn-end'
  | 'error';

export interface S2SPipelineEventV16 {
  kind: S2SPipelineEventKindV16;
  atMs: number;
  text?: string;
  message?: string;
  reason?: string;
  state?: S2SPipelineStateV16;
  queue?: 'mic' | 'reply' | 'audio';
  droppedCount?: number;
  resumeToken?: S2SResumeTokenV16;
  chunkIndex?: number;
  audioSamples?: number;
}

export type S2SPipelineSinkV16 = (event: S2SPipelineEventV16) => void;

export interface S2SPipelineOptionsV16 {
  provider?: S2SProviderKindV15;
  language?: string;
  mode?: S2SPipelineModeV16;
  /** Streaming reply generator (the "brain"); default echoes in chunks. */
  replyChunksFor?: (text: string) => string[];
  voiceProfile?: VoiceProfileV15;
  maxQueuedFrames?: number;
  maxQueuedReplyChunks?: number;
  maxQueuedAudioChunks?: number;
  maxReconnectAttempts?: number;
  s2sScript?: MockS2SScriptEventV15[];
  s2sFailConnectWith?: string;
  /** Drop the mock S2S transport this many ms after connect (test hook). */
  s2sDropAtMs?: number;
  /** Silence (ms) after the last STT word before the turn finalises. */
  sttFinalSilenceMs?: number;
  sttWordSchedule?: SttWordScheduleV16[];
}

export function defaultS2SPipelineOptionsV16(): Required<Omit<S2SPipelineOptionsV16, 'replyChunksFor' | 'voiceProfile' | 's2sScript' | 's2sFailConnectWith' | 's2sDropAtMs' | 'sttFinalSilenceMs' | 'sttWordSchedule'>> {
  return {
    provider: 'mock',
    language: 'vi',
    mode: 's2s',
    maxQueuedFrames: S2S_V16_DEFAULT_MAX_QUEUED_FRAMES,
    maxQueuedReplyChunks: S2S_V16_DEFAULT_MAX_QUEUED_REPLY_CHUNKS,
    maxQueuedAudioChunks: S2S_V16_DEFAULT_MAX_QUEUED_AUDIO_CHUNKS,
    maxReconnectAttempts: 5,
  };
}

export function validateS2SPipelineOptionsV16(options: S2SPipelineOptionsV16): string[] {
  const errors: string[] = [];
  if (options.maxQueuedFrames !== undefined && (options.maxQueuedFrames < 5 || options.maxQueuedFrames > 10000)) {
    errors.push('maxQueuedFrames must be 5..10000');
  }
  if (options.maxQueuedReplyChunks !== undefined && (options.maxQueuedReplyChunks < 1 || options.maxQueuedReplyChunks > 1000)) {
    errors.push('maxQueuedReplyChunks must be 1..1000');
  }
  if (options.maxQueuedAudioChunks !== undefined && (options.maxQueuedAudioChunks < 1 || options.maxQueuedAudioChunks > 1000)) {
    errors.push('maxQueuedAudioChunks must be 1..1000');
  }
  if (options.maxReconnectAttempts !== undefined && (options.maxReconnectAttempts < 0 || options.maxReconnectAttempts > 20)) {
    errors.push('maxReconnectAttempts must be 0..20');
  }
  return errors;
}

export interface S2SPipelineStatsV16 {
  state: S2SPipelineStateV16;
  mode: S2SPipelineModeV16;
  turns: number;
  micFrames: number;
  mic: BoundedQueueStatsV16;
  reply: BoundedQueueStatsV16;
  audio: BoundedQueueStatsV16;
  sttPartials: number;
  sttFinals: number;
  replyChunks: number;
  replyChunksSpoken: number;
  audioChunksPlayed: number;
  reconnects: number;
  resumes: number;
  fallbacks: number;
  firstAudioMs: number | undefined;
  averageFirstAudioMs: number;
  lastResumeTurnId: string | undefined;
}

interface PendingAudioV16 {
  text: string;
  audio: Int16Array;
  readyAtMs: number;
  durationMs: number;
}

/**
 * The v4 speech-to-speech pipeline. It owns the S2S adapter (v15),
 * the streaming STT, the bounded stage queues and the resume token;
 * the session owns the turn policy (when to speak, when to cut).
 * `tick(ms)` advances every sub-clock in lockstep.
 */
export class SpeechToSpeechPipelineV16 {
  readonly stt: StreamingSttV16;
  readonly s2s: S2SAdapterV15;
  private readonly options: Required<Omit<S2SPipelineOptionsV16, 'replyChunksFor' | 'voiceProfile' | 's2sScript' | 's2sFailConnectWith' | 's2sDropAtMs' | 'sttFinalSilenceMs' | 'sttWordSchedule'>> &
    Pick<S2SPipelineOptionsV16, 'replyChunksFor' | 'voiceProfile'>;
  private readonly sink: S2SPipelineSinkV16 | undefined;
  private readonly micQueue: BoundedQueueV16<{ frame: Int16Array; atMs: number }>;
  private readonly replyQueue: BoundedQueueV16<string>;
  private readonly audioQueue: BoundedQueueV16<PendingAudioV16>;
  private state: S2SPipelineStateV16 = 'idle';
  private mode: S2SPipelineModeV16;
  private nowMs = 0;
  private turnCounter = 0;
  private currentTurnId = '';
  private currentUserText = '';
  private currentReplyText = '';
  private replyChunksTotal = 0;
  private replyChunksSpoken = 0;
  private pendingFunctionCalls: string[] = [];
  private readonly pendingReplyChunks: string[] = [];
  private micFrames = 0;
  private audioChunksPlayed = 0;
  private reconnects = 0;
  private resumes = 0;
  private fallbacks = 0;
  private firstAudioAtMs: number | undefined;
  private turnStartedAtMs = 0;
  private readonly firstAudioSamples: number[] = [];
  private lastResumeTurnId: string | undefined;
  private audioPlayingUntilMs = 0;

  constructor(options: S2SPipelineOptionsV16 = {}, sink?: S2SPipelineSinkV16) {
    const defaults = defaultS2SPipelineOptionsV16();
    const merged = {
      ...defaults,
      ...options,
      maxQueuedFrames: options.maxQueuedFrames ?? defaults.maxQueuedFrames,
      maxQueuedReplyChunks: options.maxQueuedReplyChunks ?? defaults.maxQueuedReplyChunks,
      maxQueuedAudioChunks: options.maxQueuedAudioChunks ?? defaults.maxQueuedAudioChunks,
    };
    const errors = validateS2SPipelineOptionsV16(merged);
    if (errors.length > 0) throw new Error(`invalid S2S pipeline options: ${errors.join('; ')}`);
    this.options = merged;
    this.mode = merged.mode;
    this.sink = sink;
    this.micQueue = new BoundedQueueV16(merged.maxQueuedFrames);
    this.replyQueue = new BoundedQueueV16(merged.maxQueuedReplyChunks);
    this.audioQueue = new BoundedQueueV16(merged.maxQueuedAudioChunks);
    this.stt = new StreamingSttV16(
      {
        wordSchedule: options.sttWordSchedule ?? [],
        ...(options.sttFinalSilenceMs !== undefined ? { finalSilenceMs: options.sttFinalSilenceMs } : {}),
      },
      (event) => this.onSttEvent(event),
    );
    const transport = new MockS2STransportV15(merged.provider, {
      script: options.s2sScript ?? [],
      ...(options.s2sFailConnectWith !== undefined ? { failNextConnectWith: options.s2sFailConnectWith } : {}),
      ...(options.s2sDropAtMs !== undefined ? { dropAtMs: options.s2sDropAtMs } : {}),
    });
    this.s2s = createS2SAdapterV15(transport, {
      provider: merged.provider,
      language: merged.language,
      maxReconnectAttempts: merged.maxReconnectAttempts,
    }, (event: S2SEventV15) => this.onS2SEvent(event));
  }

  getState(): S2SPipelineStateV16 {
    return this.state;
  }

  getMode(): S2SPipelineModeV16 {
    return this.mode;
  }

  now(): number {
    return this.nowMs;
  }

  async connect(): Promise<void> {
    if (this.state === 'streaming' || this.state === 'connecting') return;
    this.setState('connecting');
    if (this.mode === 's2s') {
      await this.s2s.connect();
      if (this.s2s.getState() === 'failed') {
        this.fallbackToPipeline('s2s-failed');
        return;
      }
      if (this.s2s.getState() === 'connected' || this.s2s.getState() === 'reconnecting') {
        this.setState('streaming');
        return;
      }
    }
    this.setState('streaming');
  }

  disconnect(reason = 'client-close'): void {
    if (this.state === 'closed') return;
    this.s2s.disconnect(reason);
    this.setState('closed');
  }

  /** Feed one 20 ms mic frame into the pipeline (backpressure applies). */
  feedMicFrame(frame: Int16Array): void {
    if (this.state !== 'streaming' && this.state !== 'reconnecting') return;
    this.micFrames += 1;
    const { dropped, paused } = this.micQueue.push({ frame, atMs: this.nowMs });
    if (dropped !== undefined) {
      this.sink?.({ kind: 'dropped', atMs: this.nowMs, queue: 'mic', droppedCount: this.micQueue.stats().dropped, reason: 'mic-queue-full-drop-oldest' });
    }
    if (paused) {
      this.sink?.({ kind: 'backpressure', atMs: this.nowMs, queue: 'mic', message: 'mic intake paused (high-water)' });
    }
  }

  /** Feed silence (ms) — lets the STT finalise the turn. */
  feedSilence(ms: number): void {
    if (this.state !== 'streaming') return;
    this.drainMicQueue();
    this.stt.feedSilence(ms, this.nowMs);
  }

  /** Advance the virtual clock; drains queues + S2S + speaker. */
  tick(ms: number): void {
    this.nowMs += ms;
    this.s2s.tick(ms);
    if (this.s2s.getState() === 'reconnecting' && this.state === 'streaming') {
      this.setState('reconnecting');
      this.reconnects += 1;
    }
    if (this.s2s.getState() === 'connected' && this.state === 'reconnecting') {
      this.setState('streaming');
      this.sink?.({ kind: 'reconnected', atMs: this.nowMs, message: 'S2S stream reconnected' });
      this.resumeTurnAfterReconnect();
    }
    this.drainMicQueue();
    // Time passing with no frames is silence: let the STT finalise
    // a turn whose words have all arrived.
    this.stt.feedSilence(ms, this.nowMs);
    // While the stream is down the turn is held, not drained: reply
    // and audio chunks wait in their queues so the reconnect can
    // resume the turn from the first unspoken chunk instead of
    // replaying it or losing it.
    if (this.state === 'streaming') {
      this.drainReplyQueue();
      this.drainAudioQueue();
    }
  }

  /** Snapshot a resume token for the live turn (call before a drop). */
  resumeToken(): S2SResumeTokenV16 | undefined {
    if (!this.currentTurnId) return undefined;
    return {
      turnId: this.currentTurnId,
      transcriptPrefix: this.currentUserText,
      spokenReplyChunks: this.replyChunksSpoken,
      pendingReplyChunks: [...this.pendingReplyChunks],
      pendingFunctionCalls: [...this.pendingFunctionCalls],
      droppedAtMs: this.nowMs,
      reconnectAttempt: this.s2s.stats().reconnects,
    };
  }

  /** Start a turn from a final transcript (pipeline mode / test hook). */
  startTurnFromText(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.beginTurn(trimmed);
  }

  stats(): S2SPipelineStatsV16 {
    const sttStats = this.stt.stats();
    return {
      state: this.state,
      mode: this.mode,
      turns: this.turnCounter,
      micFrames: this.micFrames,
      mic: this.micQueue.stats(),
      reply: this.replyQueue.stats(),
      audio: this.audioQueue.stats(),
      sttPartials: sttStats.partials,
      sttFinals: sttStats.finals,
      replyChunks: this.replyChunksTotal,
      replyChunksSpoken: this.replyChunksSpoken,
      audioChunksPlayed: this.audioChunksPlayed,
      reconnects: this.reconnects,
      resumes: this.resumes,
      fallbacks: this.fallbacks,
      firstAudioMs: this.firstAudioAtMs,
      averageFirstAudioMs: this.firstAudioSamples.length > 0
        ? Math.round(this.firstAudioSamples.reduce((a, b) => a + b, 0) / this.firstAudioSamples.length)
        : 0,
      lastResumeTurnId: this.lastResumeTurnId,
    };
  }

  summary(): string {
    const s = this.stats();
    return `s2s pipeline v16: state=${s.state} mode=${s.mode} turns=${s.turns} ` +
      `mic=${s.micFrames}f (dropped ${s.mic.dropped}) stt=${s.sttPartials}p/${s.sttFinals}f ` +
      `reply=${s.replyChunksSpoken}/${s.replyChunks} audio=${s.audioChunksPlayed} ` +
      `reconnects=${s.reconnects} resumes=${s.resumes} fallbacks=${s.fallbacks}`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Speech-to-speech pipeline v16',
      '',
      `- State: \`${s.state}\`; mode: \`${s.mode}\`; turns: ${s.turns}`,
      `- Mic: ${s.micFrames} frames, queue ${s.mic.depth}/${s.mic.capacity} (dropped ${s.mic.dropped}, pauses ${s.mic.pauses})`,
      `- STT: ${s.sttPartials} partials, ${s.sttFinals} finals`,
      `- Reply: ${s.replyChunksSpoken}/${s.replyChunks} chunks spoken (queue dropped ${s.reply.dropped})`,
      `- Audio: ${s.audioChunksPlayed} chunks played (queue dropped ${s.audio.dropped})`,
      `- Reconnects: ${s.reconnects}; turn resumes: ${s.resumes}${s.lastResumeTurnId ? ` (last ${s.lastResumeTurnId})` : ''}; fallbacks: ${s.fallbacks}`,
      `- First audio: ${s.firstAudioMs !== undefined ? `${s.firstAudioMs} ms` : 'n/a'} (avg ${s.averageFirstAudioMs} ms)`,
      '',
    ];
    return lines.join('\n');
  }

  private setState(next: S2SPipelineStateV16): void {
    this.state = next;
    this.sink?.({ kind: 'state', atMs: this.nowMs, state: next });
  }

  private fallbackToPipeline(reason: string): void {
    // Idempotent: the S2S adapter emits a fallback event *and* the
    // connect() caller checks the failed state — both must not count.
    if (this.mode === 'pipeline') return;
    this.mode = 'pipeline';
    this.fallbacks += 1;
    this.setState('fallback');
    this.sink?.({ kind: 'fallback', atMs: this.nowMs, reason, message: 'S2S failed; continuing on the STT→LLM→TTS pipeline.' });
    this.setState('streaming');
  }

  private beginTurn(userText: string): void {
    this.turnCounter += 1;
    this.currentTurnId = `turn-${this.turnCounter}`;
    this.currentUserText = userText;
    this.currentReplyText = '';
    this.replyChunksSpoken = 0;
    this.pendingReplyChunks.length = 0;
    this.pendingFunctionCalls.length = 0;
    this.turnStartedAtMs = this.nowMs;
    this.firstAudioAtMs = undefined;
    // A new turn supersedes the previous one: drop reply/audio
    // still queued for it (already-played audio cannot be un-played,
    // but queued chunks must never leak into the new turn — a leak
    // once produced a negative first-audio latency here).
    this.replyQueue.clear();
    this.audioQueue.clear();
    this.audioPlayingUntilMs = 0;
    const replyChunksFor = this.options.replyChunksFor ?? ((text: string): string[] => [`Bạn vừa nói: ${text}`]);
    const chunks = replyChunksFor(userText);
    this.replyChunksTotal += chunks.length;
    for (const chunk of chunks) {
      const { dropped, paused } = this.replyQueue.push(chunk);
      if (dropped !== undefined) {
        this.sink?.({ kind: 'dropped', atMs: this.nowMs, queue: 'reply', droppedCount: this.replyQueue.stats().dropped, reason: 'reply-queue-full-drop-oldest' });
      }
      if (paused) {
        this.sink?.({ kind: 'backpressure', atMs: this.nowMs, queue: 'reply', message: 'reply intake paused (high-water)' });
      }
      this.pendingReplyChunks.push(chunk);
    }
  }

  private drainMicQueue(): void {
    // Draining relieves pressure: every queued frame is consumed in
    // order, so the queue falls back below low-water and intake
    // resumes. The pause flag only ever gates *intake* signalling.
    let item = this.micQueue.shift();
    while (item !== undefined) {
      this.stt.feedFrame(item.frame, this.nowMs);
      item = this.micQueue.shift();
    }
  }

  private drainReplyQueue(): void {
    while (this.replyQueue.length > 0) {
      const chunk = this.replyQueue.shift();
      if (chunk === undefined) break;
      const profile = this.options.voiceProfile;
      const textChunks = chunkTtsTextV15(chunk, profile?.maxChunkChars ?? 120);
      for (const textChunk of textChunks) {
        const { audio, synthMs } = mockTtsSynthV15(textChunk, profile ?? {
          id: 'profile-default', botId: 'default-bot', provider: 'mock', voiceId: 'default',
          language: this.options.language, rate: 1, pitch: 0, quality: 'high', maxChunkChars: 120,
        });
        const durationMs = Math.max(20, Math.round((audio.length / S2S_V16_SAMPLE_RATE_HZ) * 1000));
        const { dropped, paused } = this.audioQueue.push({
          text: textChunk.text,
          audio,
          readyAtMs: this.nowMs + synthMs,
          durationMs,
        });
        if (dropped !== undefined) {
          this.sink?.({ kind: 'dropped', atMs: this.nowMs, queue: 'audio', droppedCount: this.audioQueue.stats().dropped, reason: 'audio-queue-full-drop-oldest' });
        }
        if (paused) {
          this.sink?.({ kind: 'backpressure', atMs: this.nowMs, queue: 'audio', message: 'speaker queue paused (high-water)' });
        }
      }
      this.replyChunksSpoken += 1;
      this.pendingReplyChunks.shift();
      this.currentReplyText += (this.currentReplyText ? ' ' : '') + chunk;
      this.sink?.({ kind: 'reply-chunk', atMs: this.nowMs, text: chunk, chunkIndex: this.replyChunksSpoken - 1 });
    }
  }

  private drainAudioQueue(): void {
    // Playout runs on an audio-time cursor, not on the tick size:
    // a chunk plays at max(previous chunk's end, its ready time),
    // so one long tick plays every chunk whose audio time has
    // elapsed instead of a single chunk per tick.
    for (;;) {
      const next = this.audioQueue.peek();
      if (!next) break;
      const playAtMs = Math.max(this.audioPlayingUntilMs, next.readyAtMs);
      if (playAtMs > this.nowMs) break;
      this.audioQueue.shift();
      this.audioChunksPlayed += 1;
      if (this.firstAudioAtMs === undefined) {
        this.firstAudioAtMs = playAtMs - this.turnStartedAtMs;
        this.firstAudioSamples.push(this.firstAudioAtMs);
      }
      this.audioPlayingUntilMs = playAtMs + next.durationMs;
      this.sink?.({ kind: 'audio', atMs: playAtMs, text: next.text, audioSamples: next.audio.length, chunkIndex: this.audioChunksPlayed - 1 });
      if (this.audioQueue.length === 0 && this.replyQueue.length === 0 && this.pendingReplyChunks.length === 0 && this.currentTurnId) {
        this.sink?.({ kind: 'turn-end', atMs: playAtMs, text: this.currentUserText });
        this.currentTurnId = '';
      }
    }
  }

  private resumeTurnAfterReconnect(): void {
    const token = this.resumeToken();
    if (!token || token.pendingReplyChunks.length === 0) return;
    this.resumes += 1;
    this.lastResumeTurnId = token.turnId;
    // Re-send the transcript prefix as context, then resume the reply
    // from the first unspoken chunk — never from the start. The
    // reply queue is rebuilt from the token so a chunk is spoken
    // exactly once even if it was already queued when the drop hit.
    if (this.mode === 's2s') {
      this.s2s.sendText(token.transcriptPrefix);
    }
    this.replyQueue.clear();
    for (const chunk of token.pendingReplyChunks) {
      this.replyQueue.push(chunk);
    }
    this.sink?.({ kind: 'resumed', atMs: this.nowMs, resumeToken: token, message: `Resumed ${token.turnId} from chunk ${token.spokenReplyChunks}.` });
  }

  private onSttEvent(event: { kind: string; atMs: number; text: string }): void {
    if (event.kind === 'partial') {
      this.sink?.({ kind: 'stt-partial', atMs: event.atMs, text: event.text });
      return;
    }
    if (event.kind === 'final') {
      this.sink?.({ kind: 'stt-final', atMs: event.atMs, text: event.text });
      this.beginTurn(event.text);
    }
  }

  private onS2SEvent(event: S2SEventV15): void {
    if (event.kind === 'fallback') {
      this.fallbackToPipeline(event.reason ?? 's2s-failed');
      return;
    }
    if (event.kind === 'function-call' && event.call) {
      this.pendingFunctionCalls.push(event.call.name);
    }
    if (event.kind === 'transcript-final' && event.text) {
      this.beginTurn(event.text);
    }
  }
}

export function createS2SPipelineV16(options: S2SPipelineOptionsV16 = {}, sink?: S2SPipelineSinkV16): SpeechToSpeechPipelineV16 {
  return new SpeechToSpeechPipelineV16(options, sink);
}

export function s2sV16Summary(pipeline: SpeechToSpeechPipelineV16): string {
  return pipeline.summary();
}

export function s2sV16Markdown(pipeline: SpeechToSpeechPipelineV16): string {
  return pipeline.markdown();
}
