/**
 * Streaming TTS cache v21 (voice v21, v1.34 Team T5).
 *
 * Speaking the same sentence twice should not synthesise it
 * twice. The cache keys entries by a hash of text + voice (+
 * speaking rate), stores the synthesised audio as chunks, and
 * streams those chunks back one at a time instead of making the
 * caller wait for a whole sentence:
 *
 *   - Hit: the entry's chunks are yielded immediately, in order,
 *     and the hit counter + last-hit time move.
 *   - Miss: the synthesiser runs once, chunk by chunk; each
 *     chunk is yielded as soon as it arrives *and* stored, so a
 *     long reply starts playing before it finishes synthesising.
 *   - Expiry: entries older than the TTL are dropped on access
 *     (and by `prune`), so a stale voice never plays.
 *   - Capacity: when the cache is full (entries or bytes), the
 *     least-recently-used entry is evicted first; oversized
 *     single entries are never stored.
 *
 * Audio here is mock/synthetic PCM16 (a sine tone per chunk, at
 * 16 kHz) so the cache, the chunking and the eviction all work
 * with no provider, no key and no sound card. The host can bind
 * a real synthesiser through `VoiceV21TtsSynthesizer`; the
 * cache only cares that it yields `Uint8Array` chunks.
 */
import {
  round4V21,
  type VoiceV21EventSink,
} from './types';

export type VoiceV21TtsChunk = Uint8Array;

/** A synthesiser: yields audio chunks for text in a voice. */
export type VoiceV21TtsSynthesizer = (
  text: string,
  voice: string,
  opts: { rate: number },
) => AsyncIterable<VoiceV21TtsChunk>;

export interface VoiceV21TtsCacheOptions {
  /** Entry lifetime in ms (default 3600_000 = 1 h). */
  ttlMs: number;
  /** Max entries (default 200). */
  maxEntries: number;
  /** Max total bytes (default 32 MiB). */
  maxBytes: number;
  /** Max chars per chunk when splitting text (default 120). */
  maxChunkChars: number;
  /** Speaking rate multiplier for the key (default 1). */
  rate: number;
}

export function defaultTtsCacheV21Options(): VoiceV21TtsCacheOptions {
  return {
    ttlMs: 3_600_000,
    maxEntries: 200,
    maxBytes: 32 * 1024 * 1024,
    maxChunkChars: 120,
    rate: 1,
  };
}

export function validateTtsCacheV21Options(o: Partial<VoiceV21TtsCacheOptions>): string[] {
  const e: string[] = [];
  if (o.ttlMs !== undefined && o.ttlMs <= 0) e.push('ttlMs must be positive');
  if (o.maxEntries !== undefined && (!Number.isInteger(o.maxEntries) || o.maxEntries < 1)) {
    e.push('maxEntries must be a positive integer');
  }
  if (o.maxBytes !== undefined && o.maxBytes < 1024) e.push('maxBytes must be at least 1024');
  if (o.maxChunkChars !== undefined && (o.maxChunkChars < 10 || o.maxChunkChars > 2000)) {
    e.push('maxChunkChars must be 10..2000');
  }
  if (o.rate !== undefined && (o.rate < 0.5 || o.rate > 2)) e.push('rate must be 0.5..2');
  return e;
}

/** FNV-1a 32-bit hash, hex — deterministic, no dependency. */
export function fnv1aV21(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Cache key for a (text, voice, rate) triple. */
export function ttsCacheKeyV21(text: string, voice: string, rate = 1): string {
  return fnv1aV21(`${voice}|${rate}|${text}`);
}

/** Split reply text into speakable chunks (sentence-aware, capped length). */
export function splitTtsTextV21(text: string, maxChars: number): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    // Long sentence: split on commas first, then hard-cut on words.
    const parts = sentence.split(/(?<=,)\s+/);
    let current = '';
    for (const part of parts) {
      if ((current + ' ' + part).trim().length <= maxChars) {
        current = (current + ' ' + part).trim();
      } else {
        if (current !== '') chunks.push(current);
        if (part.length <= maxChars) {
          current = part;
        } else {
          const words = part.split(/\s+/);
          let line = '';
          for (const w of words) {
            if ((line + ' ' + w).trim().length <= maxChars) line = (line + ' ' + w).trim();
            else {
              if (line !== '') chunks.push(line);
              line = w;
            }
          }
          current = line;
        }
      }
    }
    if (current !== '') chunks.push(current);
  }
  return chunks;
}

/** Mock synthesiser: one synthetic PCM16 chunk per text chunk (440 Hz tone). */
export async function* mockSynthesizerV21(
  text: string,
  _voice: string,
  opts: { rate: number; maxChunkChars?: number },
): AsyncIterable<VoiceV21TtsChunk> {
  const chunks = splitTtsTextV21(text, opts.maxChunkChars ?? 120);
  for (const chunk of chunks) {
    // ~40 ms of audio per 10 chars, scaled by rate; 16 kHz mono PCM16.
    const samples = Math.max(320, Math.round((chunk.length / 10) * 640 / opts.rate));
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i += 1) {
      pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    }
    yield new Uint8Array(pcm.buffer);
  }
}

export interface VoiceV21TtsCacheEntry {
  key: string;
  text: string;
  voice: string;
  rate: number;
  chunks: VoiceV21TtsChunk[];
  /** Total bytes across chunks. */
  bytes: number;
  /** Estimated spoken duration, ms (mock: 40 ms per 10 chars). */
  durationMs: number;
  createdAtMs: number;
  lastHitAtMs: number;
  hits: number;
}

export interface VoiceV21TtsCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  expired: number;
  storedChunks: number;
}

export interface VoiceV21TtsStreamResult {
  key: string;
  hit: boolean;
  chunks: VoiceV21TtsChunk[];
  durationMs: number;
}

export class TtsCacheV21 {
  private readonly opts: VoiceV21TtsCacheOptions;
  private readonly synthesizer: VoiceV21TtsSynthesizer;
  private readonly sink?: VoiceV21EventSink;
  private readonly sessionId: string;
  private readonly entries = new Map<string, VoiceV21TtsCacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;

  constructor(
    sessionId: string,
    opts: Partial<VoiceV21TtsCacheOptions> = {},
    synthesizer?: VoiceV21TtsSynthesizer,
    sink?: VoiceV21EventSink,
  ) {
    this.sessionId = sessionId;
    this.opts = { ...defaultTtsCacheV21Options(), ...opts };
    this.synthesizer = synthesizer ?? ((text, voice, o) => mockSynthesizerV21(text, voice, { ...o, maxChunkChars: this.opts.maxChunkChars }));
    this.sink = sink;
  }

  keyFor(text: string, voice: string): string {
    return ttsCacheKeyV21(text, voice, this.opts.rate);
  }

  has(key: string, atMs: number): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (atMs - entry.createdAtMs > this.opts.ttlMs) {
      this.entries.delete(key);
      this.expired += 1;
      return false;
    }
    return true;
  }

  get(key: string): VoiceV21TtsCacheEntry | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : { ...entry, chunks: [...entry.chunks] };
  }

  /** Drop expired entries. Returns how many were dropped. */
  prune(atMs: number): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (atMs - entry.createdAtMs > this.opts.ttlMs) {
        this.entries.delete(key);
        this.expired += 1;
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Current total bytes stored. */
  bytesUsed(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.bytes;
    return total;
  }

  private store(entry: VoiceV21TtsCacheEntry): void {
    if (entry.bytes > this.opts.maxBytes) return; // Never store an oversized entry.
    // Evict least-recently-used until there is room (entries + bytes).
    while (
      (this.entries.size >= this.opts.maxEntries || this.bytesUsed() + entry.bytes > this.opts.maxBytes)
      && this.entries.size > 0
    ) {
      let lruKey: string | undefined;
      let lruTime = Number.POSITIVE_INFINITY;
      for (const [key, e] of this.entries) {
        if (e.lastHitAtMs < lruTime) { lruTime = e.lastHitAtMs; lruKey = key; }
      }
      if (lruKey === undefined) break;
      this.entries.delete(lruKey);
      this.evictions += 1;
    }
    this.entries.set(entry.key, entry);
  }

  /**
   * Speak text: stream chunks, from cache on a hit, from the
   * synthesiser on a miss (storing as it goes). The returned
   * async generator yields each chunk as soon as it is ready.
   */
  async *speak(
    text: string,
    voice: string,
    atMs: number,
  ): AsyncGenerator<VoiceV21TtsChunk, VoiceV21TtsStreamResult, void> {
    const key = this.keyFor(text, voice);
    const cached = this.entries.get(key);
    if (cached !== undefined && atMs - cached.createdAtMs <= this.opts.ttlMs) {
      this.hits += 1;
      cached.hits += 1;
      cached.lastHitAtMs = atMs;
      this.sink?.({ kind: 'tts-cache-hit', atMs, sessionId: this.sessionId, detail: { key, chunks: cached.chunks.length } });
      for (const chunk of cached.chunks) yield chunk;
      return { key, hit: true, chunks: cached.chunks, durationMs: cached.durationMs };
    }
    if (cached !== undefined) {
      this.entries.delete(key);
      this.expired += 1;
    }
    this.misses += 1;
    this.sink?.({ kind: 'tts-cache-miss', atMs, sessionId: this.sessionId, detail: { key } });
    const chunks: VoiceV21TtsChunk[] = [];
    let bytes = 0;
    const startedAt = Date.now();
    for await (const chunk of this.synthesizer(text, voice, { rate: this.opts.rate })) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      yield chunk;
    }
    const durationMs = Math.max(1, Math.round((text.length / 10) * 40 / this.opts.rate));
    void startedAt;
    this.store({
      key,
      text,
      voice,
      rate: this.opts.rate,
      chunks,
      bytes,
      durationMs,
      createdAtMs: atMs,
      lastHitAtMs: atMs,
      hits: 0,
    });
    return { key, hit: false, chunks, durationMs };
  }

  /**
   * Non-streaming convenience: synthesise (or hit) and collect
   * all chunks. Prefer `speak` when playback should start early.
   */
  async synthesize(text: string, voice: string, atMs: number): Promise<VoiceV21TtsStreamResult> {
    const chunks: VoiceV21TtsChunk[] = [];
    let result: VoiceV21TtsStreamResult | undefined;
    const gen = this.speak(text, voice, atMs);
    while (true) {
      const next = await gen.next();
      if (next.done) { result = next.value; break; }
      chunks.push(next.value);
    }
    return result ?? { key: this.keyFor(text, voice), hit: false, chunks, durationMs: 0 };
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): VoiceV21TtsCacheStats {
    const total = this.hits + this.misses;
    let storedChunks = 0;
    for (const e of this.entries.values()) storedChunks += e.chunks.length;
    return {
      entries: this.entries.size,
      bytes: this.bytesUsed(),
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : round4V21(this.hits / total),
      evictions: this.evictions,
      expired: this.expired,
      storedChunks,
    };
  }

  summary(): string {
    const s = this.stats();
    return `tts cache: ${s.entries} entries, ${s.bytes} bytes, hit rate ${(s.hitRate * 100).toFixed(1)}% ` +
      `(${s.hits} hits / ${s.misses} misses), ${s.evictions} evictions, ${s.expired} expired`;
  }
}

export function createTtsCacheV21(
  sessionId: string,
  opts: Partial<VoiceV21TtsCacheOptions> = {},
  synthesizer?: VoiceV21TtsSynthesizer,
  sink?: VoiceV21EventSink,
): TtsCacheV21 {
  return new TtsCacheV21(sessionId, opts, synthesizer, sink);
}

/** Estimate spoken duration for text at a rate (mock model: 40 ms per 10 chars). */
export function estimateTtsDurationMsV21(text: string, rate = 1): number {
  return Math.max(1, Math.round((text.length / 10) * 40 / rate));
}
