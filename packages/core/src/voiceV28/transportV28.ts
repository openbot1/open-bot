/**
 * Mock realtime transport v28 (v1.41, Team T5).
 *
 * Streaming audio chunks in and out for a realtime voice
 * session. This transport is a MOCK: chunks are synthetic
 * PCM16 frames produced by the caller (or by the built-in
 * tone/noise synthesizer), delivered through in-memory
 * queues with a simulated latency + jitter, and never touch
 * a network, a provider API, a key, a mic or a sound card.
 * A real provider transport (WebSocket / WebRTC) can replace
 * this class later behind the same `pushChunk` / `pullChunk`
 * surface — the session only talks to the surface, never to
 * the queues.
 *
 * Behaviour:
 *   - two directions, `in` (mic -> agent) and `out` (agent ->
 *     speaker), each a FIFO queue with a max depth;
 *   - when a queue is full the drop policy fires
 *     (drop-oldest / drop-newest / block-returns-false) and
 *     the drop is counted + logged as an event;
 *   - delivery delay = simulatedLatencyMs + a deterministic
 *     pseudo-jitter derived from the chunk sequence (no
 *     randomness, so tests are repeatable): the caller passes
 *     `atMs` and `deliverAtMs(atMs, seq)` tells when the
 *     chunk becomes readable;
 *   - a jitter buffer on the output side holds chunks until
 *     their target playout time (target = first chunk time +
 *     jitterBufferTargetMs), smoothing bursty arrivals;
 *   - stats: chunks in/out, dropped, bytes, latency p50/p95,
 *     underruns (pull on an empty output queue while
 *     speaking), current queue depths.
 *
 * All clocks virtual: the caller passes `atMs` everywhere.
 */

import {
  clampV28,
  defaultTransportConfigV28,
  round2V28,
  percentileV28,
  type VoiceV28AudioChunk,
  type VoiceV28ChunkSource,
  type VoiceV28TransportConfig,
} from './types';

export interface MockRealtimeTransportV28Options {
  config?: Partial<VoiceV28TransportConfig>;
  /** Jitter-buffer target delay for the output side (ms). */
  jitterBufferTargetMs?: number;
  /** Max transport events kept (oldest dropped first). */
  maxEvents?: number;
  /** Max latency samples kept for p50/p95. */
  maxLatencySamples?: number;
}

export interface VoiceV28TransportEvent {
  atMs: number;
  kind: 'push' | 'pull' | 'drop' | 'underrun' | 'flush' | 'close';
  source: VoiceV28ChunkSource;
  seq: number | null;
  detail: string;
}

export interface VoiceV28TransportStats {
  chunksIn: number;
  chunksOut: number;
  bytesIn: number;
  bytesOut: number;
  droppedIn: number;
  droppedOut: number;
  underruns: number;
  /** Delivered chunks whose delay was measured (ms). */
  latencySamples: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  queueInDepth: number;
  queueOutDepth: number;
  nextSeqIn: number;
  nextSeqOut: number;
  closed: boolean;
}

/** Deterministic pseudo-jitter for a chunk (ms, 0..simulatedJitterMs). */
export function jitterForSeqV28(seq: number, simulatedJitterMs: number): number {
  if (simulatedJitterMs <= 0) return 0;
  // Golden-ratio hash: deterministic, well spread, no RNG.
  const frac = ((seq * 2654435761) % 1000) / 1000;
  return Math.round(frac * simulatedJitterMs);
}

/** Synthesize a PCM16-normalised tone chunk (mock mic/tts audio). */
export function synthToneChunkV28(
  seq: number,
  atMs: number,
  source: VoiceV28ChunkSource,
  opts: {
    sampleRate?: number;
    chunkSamples?: number;
    frequencyHz?: number;
    amplitude?: number;
    final?: boolean;
  } = {},
): VoiceV28AudioChunk {
  const sampleRate = opts.sampleRate ?? 16000;
  const chunkSamples = opts.chunkSamples ?? 480;
  const frequencyHz = opts.frequencyHz ?? (source === 'mic' ? 220 : 440);
  const amplitude = clampV28(opts.amplitude ?? 0.5, 0, 1);
  const samples: number[] = [];
  for (let i = 0; i < chunkSamples; i += 1) {
    const t = (seq * chunkSamples + i) / sampleRate;
    samples.push(round2V28(amplitude * Math.sin(2 * Math.PI * frequencyHz * t)));
  }
  return {
    seq,
    atMs,
    source,
    samples,
    sampleRate,
    channels: 1,
    final: opts.final ?? false,
  };
}

/** Synthesize a silence chunk (all-zero samples). */
export function synthSilenceChunkV28(
  seq: number,
  atMs: number,
  source: VoiceV28ChunkSource,
  opts: { sampleRate?: number; chunkSamples?: number; final?: boolean } = {},
): VoiceV28AudioChunk {
  const chunkSamples = opts.chunkSamples ?? 480;
  return {
    seq,
    atMs,
    source,
    samples: new Array<number>(chunkSamples).fill(0),
    sampleRate: opts.sampleRate ?? 16000,
    channels: 1,
    final: opts.final ?? false,
  };
}

/** RMS energy of a chunk (0..1), the number the VAD hook reads. */
export function chunkEnergyV28(chunk: VoiceV28AudioChunk): number {
  if (chunk.samples.length === 0) return 0;
  let sum = 0;
  for (const s of chunk.samples) sum += s * s;
  return round2V28(Math.sqrt(sum / chunk.samples.length));
}

/** Validate a chunk (throws on the first problem found). */
export function validateAudioChunkV28(chunk: VoiceV28AudioChunk): void {
  if (!chunk || typeof chunk !== 'object') throw new Error('chunk must be an object');
  if (!Number.isInteger(chunk.seq) || chunk.seq < 0) {
    throw new Error('chunk.seq must be a non-negative integer');
  }
  if (!Number.isFinite(chunk.atMs) || chunk.atMs < 0) {
    throw new Error('chunk.atMs must be a non-negative finite number');
  }
  if (chunk.source !== 'mic' && chunk.source !== 'tts') {
    throw new Error('chunk.source must be "mic" or "tts"');
  }
  if (!Array.isArray(chunk.samples) || chunk.samples.length === 0) {
    throw new Error('chunk.samples must be a non-empty array');
  }
  for (const s of chunk.samples) {
    if (typeof s !== 'number' || !Number.isFinite(s) || s < -1 || s > 1) {
      throw new Error('chunk.samples entries must be finite numbers in [-1, 1]');
    }
  }
  if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
    throw new Error('chunk.sampleRate must be a positive finite number');
  }
  if (!Number.isInteger(chunk.channels) || chunk.channels < 1) {
    throw new Error('chunk.channels must be a positive integer');
  }
}

export function defaultMockRealtimeTransportV28Options(): MockRealtimeTransportV28Options {
  return { config: defaultTransportConfigV28(), jitterBufferTargetMs: 120, maxEvents: 1000, maxLatencySamples: 2000 };
}

export function createMockRealtimeTransportV28(
  opts: MockRealtimeTransportV28Options = {},
): MockRealtimeTransportV28 {
  return new MockRealtimeTransportV28(opts);
}

/** One queued chunk plus its computed delivery time. */
interface QueuedChunk {
  chunk: VoiceV28AudioChunk;
  deliverAtMs: number;
  enqueuedAtMs: number;
}

export class MockRealtimeTransportV28 {
  readonly config: VoiceV28TransportConfig;
  private readonly jitterBufferTargetMs: number;
  private readonly maxEvents: number;
  private readonly maxLatencySamples: number;
  private inQueue: QueuedChunk[] = [];
  private outQueue: QueuedChunk[] = [];
  private eventLog: VoiceV28TransportEvent[] = [];
  private latencySamples: number[] = [];
  private chunksIn = 0;
  private chunksOut = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private droppedIn = 0;
  private droppedOut = 0;
  private underruns = 0;
  private nextSeqIn = 0;
  private nextSeqOut = 0;
  private closedFlag = false;
  /** Playout anchor for the jitter buffer (null until the first out chunk). */
  private playoutAnchorMs: number | null = null;
  private playoutAnchorChunkAtMs: number | null = null;

  constructor(opts: MockRealtimeTransportV28Options = {}) {
    const merged: VoiceV28TransportConfig = {
      ...defaultTransportConfigV28(),
      ...(opts.config ?? {}),
    };
    if (!Number.isInteger(merged.chunkSamples) || merged.chunkSamples <= 0) {
      throw new Error('transport chunkSamples must be a positive integer');
    }
    if (!Number.isFinite(merged.sampleRate) || merged.sampleRate <= 0) {
      throw new Error('transport sampleRate must be a positive finite number');
    }
    if (!Number.isInteger(merged.maxBufferedChunks) || merged.maxBufferedChunks < 1) {
      throw new Error('transport maxBufferedChunks must be an integer >= 1');
    }
    if (merged.simulatedLatencyMs < 0 || merged.simulatedJitterMs < 0) {
      throw new Error('transport simulated latency/jitter must be >= 0');
    }
    this.config = merged;
    this.jitterBufferTargetMs = Math.max(0, opts.jitterBufferTargetMs ?? 120);
    this.maxEvents = Math.max(1, opts.maxEvents ?? 1000);
    this.maxLatencySamples = Math.max(1, opts.maxLatencySamples ?? 2000);
  }

  /** When a chunk produced at `atMs` becomes readable (latency + jitter). */
  deliverAtMs(atMs: number, seq: number): number {
    return atMs + this.config.simulatedLatencyMs + jitterForSeqV28(seq, this.config.simulatedJitterMs);
  }

  /** Push an inbound (mic) chunk into the transport. False = blocked/dropped. */
  pushIn(chunk: VoiceV28AudioChunk): boolean {
    return this.push(chunk, 'mic');
  }

  /** Push an outbound (tts) chunk into the transport. False = blocked/dropped. */
  pushOut(chunk: VoiceV28AudioChunk): boolean {
    return this.push(chunk, 'tts');
  }

  private push(chunk: VoiceV28AudioChunk, source: VoiceV28ChunkSource): boolean {
    if (this.closedFlag) return false;
    validateAudioChunkV28(chunk);
    if (chunk.source !== source) {
      throw new Error(`chunk.source must be "${source}" for this direction`);
    }
    const queue = source === 'mic' ? this.inQueue : this.outQueue;
    if (queue.length >= this.config.maxBufferedChunks) {
      if (this.config.dropPolicy === 'block') {
        this.record({ atMs: chunk.atMs, kind: 'drop', source, seq: chunk.seq, detail: 'queue full, blocked (dropPolicy=block)' });
        if (source === 'mic') this.droppedIn += 1;
        else this.droppedOut += 1;
        return false;
      }
      if (this.config.dropPolicy === 'drop-newest') {
        this.record({ atMs: chunk.atMs, kind: 'drop', source, seq: chunk.seq, detail: 'queue full, newest dropped' });
        if (source === 'mic') this.droppedIn += 1;
        else this.droppedOut += 1;
        return false;
      }
      // drop-oldest: evict the head, then accept the new chunk.
      const evicted = queue.shift();
      if (evicted) {
        this.record({ atMs: chunk.atMs, kind: 'drop', source, seq: evicted.chunk.seq, detail: 'queue full, oldest dropped' });
        if (source === 'mic') this.droppedIn += 1;
        else this.droppedOut += 1;
      }
    }
    const deliverAt = this.deliverAtMs(chunk.atMs, chunk.seq);
    queue.push({ chunk, deliverAtMs: deliverAt, enqueuedAtMs: chunk.atMs });
    if (source === 'mic') {
      this.chunksIn += 1;
      this.bytesIn += chunk.samples.length * 2;
      this.nextSeqIn = Math.max(this.nextSeqIn, chunk.seq + 1);
    } else {
      this.chunksOut += 1;
      this.bytesOut += chunk.samples.length * 2;
      this.nextSeqOut = Math.max(this.nextSeqOut, chunk.seq + 1);
      if (this.playoutAnchorMs === null) {
        this.playoutAnchorMs = deliverAt + this.jitterBufferTargetMs;
        this.playoutAnchorChunkAtMs = chunk.atMs;
      }
    }
    this.record({ atMs: chunk.atMs, kind: 'push', source, seq: chunk.seq, detail: `queued, deliver at ${deliverAt}ms` });
    return true;
  }

  /**
   * Pull the next readable inbound chunk at virtual time `atMs`
   * (null when nothing is deliverable yet).
   */
  pullIn(atMs: number): VoiceV28AudioChunk | null {
    if (this.closedFlag) return null;
    const head = this.inQueue[0];
    if (!head || head.deliverAtMs > atMs) return null;
    this.inQueue.shift();
    this.latencySamples.push(atMs - head.enqueuedAtMs);
    if (this.latencySamples.length > this.maxLatencySamples) this.latencySamples.shift();
    this.record({ atMs, kind: 'pull', source: 'mic', seq: head.chunk.seq, detail: 'delivered inbound' });
    return head.chunk;
  }

  /**
   * Pull the next playable outbound chunk at virtual time `atMs`
   * through the jitter buffer (null when nothing is due yet).
   * Counts an underrun when the queue is empty but the caller
   * expected audio (`expectingAudio`).
   */
  pullOut(atMs: number, expectingAudio = false): VoiceV28AudioChunk | null {
    if (this.closedFlag) return null;
    const head = this.outQueue[0];
    if (!head) {
      if (expectingAudio) {
        this.underruns += 1;
        this.record({ atMs, kind: 'underrun', source: 'tts', seq: null, detail: 'output queue empty while speaking' });
      }
      return null;
    }
    const playoutAt = this.playoutTimeFor(head);
    if (playoutAt > atMs) return null;
    this.outQueue.shift();
    this.latencySamples.push(atMs - head.enqueuedAtMs);
    if (this.latencySamples.length > this.maxLatencySamples) this.latencySamples.shift();
    this.record({ atMs, kind: 'pull', source: 'tts', seq: head.chunk.seq, detail: 'played outbound' });
    return head.chunk;
  }

  /** Playout time of a queued outbound chunk (jitter-buffered). */
  playoutTimeFor(queued: QueuedChunk): number {
    if (this.playoutAnchorMs === null || this.playoutAnchorChunkAtMs === null) {
      return queued.deliverAtMs;
    }
    const offset = queued.chunk.atMs - this.playoutAnchorChunkAtMs;
    return this.playoutAnchorMs + offset;
  }

  /** Drain every readable chunk in both directions at `atMs`. */
  drain(atMs: number): { in: VoiceV28AudioChunk[]; out: VoiceV28AudioChunk[] } {
    const inChunks: VoiceV28AudioChunk[] = [];
    const outChunks: VoiceV28AudioChunk[] = [];
    let next: VoiceV28AudioChunk | null;
    while ((next = this.pullIn(atMs)) !== null) inChunks.push(next);
    while ((next = this.pullOut(atMs)) !== null) outChunks.push(next);
    return { in: inChunks, out: outChunks };
  }

  /** Drop all queued chunks in both directions (counts as a flush, not a drop). */
  flush(atMs: number): { flushedIn: number; flushedOut: number } {
    const flushedIn = this.inQueue.length;
    const flushedOut = this.outQueue.length;
    this.inQueue = [];
    this.outQueue = [];
    this.playoutAnchorMs = null;
    this.playoutAnchorChunkAtMs = null;
    this.record({ atMs, kind: 'flush', source: 'mic', seq: null, detail: `flushed ${flushedIn} in / ${flushedOut} out` });
    return { flushedIn, flushedOut };
  }

  /** Close the transport (further pushes/pulls return false/null). */
  close(atMs: number): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.record({ atMs, kind: 'close', source: 'mic', seq: null, detail: 'transport closed' });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get queueInDepth(): number {
    return this.inQueue.length;
  }

  get queueOutDepth(): number {
    return this.outQueue.length;
  }

  stats(): VoiceV28TransportStats {
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    return {
      chunksIn: this.chunksIn,
      chunksOut: this.chunksOut,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      droppedIn: this.droppedIn,
      droppedOut: this.droppedOut,
      underruns: this.underruns,
      latencySamples: this.latencySamples.length,
      latencyP50Ms: this.latencySamples.length > 0 ? percentileV28(sorted, 50) : null,
      latencyP95Ms: this.latencySamples.length > 0 ? percentileV28(sorted, 95) : null,
      latencyMaxMs: this.latencySamples.length > 0 ? sorted[sorted.length - 1] : null,
      queueInDepth: this.inQueue.length,
      queueOutDepth: this.outQueue.length,
      nextSeqIn: this.nextSeqIn,
      nextSeqOut: this.nextSeqOut,
      closed: this.closedFlag,
    };
  }

  events(): VoiceV28TransportEvent[] {
    return [...this.eventLog];
  }

  private record(event: VoiceV28TransportEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEvents) this.eventLog.shift();
  }
}
