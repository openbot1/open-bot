/**
 * TTS streaming v3 + voice profiles (v1.16, Đội T5 — voice v15).
 *
 * First-audio latency is what the user feels: a TTS that waits for
 * the whole sentence before speaking adds its full synthesis time to
 * the turn. Streaming TTS (Cartesia Sonic ~40 ms, ElevenLabs Flash
 * v2.5 ~75 ms to first audio) synthesises clause by clause, so the
 * first chunk can play while the rest is still being generated.
 *
 * This module is the *client-side* streaming machinery, provider
 * agnostic (the synth itself is injected — a mock in tests, a real
 * provider adapter in production; no key, no network here):
 *
 *   - `TtsChunkerV15` splits reply text into speakable chunks at
 *     clause boundaries (commas, semicolons, sentence ends), capped
 *     at a max chunk length so a long sentence still streams;
 *   - `TtsStreamV15` drives one utterance: it asks the synth for
 *     each chunk in order, emits `audio` events as chunks arrive
 *     (each chunk is synthetic PCM16 in the mock — the shape, not
 *     the sound, is what the session needs), measures time-to-first-
 *     audio, and supports *mid-stream cancellation*: `cancel()` stops
 *     the synth, marks the remaining chunks cancelled, and reports
 *     exactly how many characters were already spoken so the
 *     session can resume or re-speak from the cut point;
 *   - `VoiceProfileV15` is a per-bot voice: provider, voice id,
 *     rate, pitch, language and a quality level that the latency
 *     pipeline can step down (`full` → `fast` → `minimal`) when
 *     p95 is over budget — the profile, not the code, decides what
 *     "faster" means for that bot;
 *   - `VoiceProfileStoreV15` keeps profiles per bot id, validates
 *     them, and hands the session the profile for the active bot.
 *
 * Determinism: the stream owns a virtual clock. `tick(ms)` advances
 * synthesis: each chunk takes its scripted `synthMs` (mock) before
 * its audio event fires. No sound card.
 */

export type TtsQualityV15 = 'high' | 'fast' | 'minimal';
export const TTS_V15_QUALITIES: readonly TtsQualityV15[] = ['high', 'fast', 'minimal'];

export interface VoiceProfileV15 {
  id: string;
  botId: string;
  provider: string;
  voiceId: string;
  language: string;
  /** Playback rate multiplier (0.5..2). */
  rate: number;
  /** Pitch shift in semitones (-12..12). */
  pitch: number;
  quality: TtsQualityV15;
  /** Max characters per streamed chunk. */
  maxChunkChars: number;
}

export function defaultVoiceProfileV15(botId: string): VoiceProfileV15 {
  return {
    id: `profile-${botId}`,
    botId,
    provider: 'mock',
    voiceId: 'default',
    language: 'vi',
    rate: 1,
    pitch: 0,
    quality: 'high',
    maxChunkChars: 120,
  };
}

export function validateVoiceProfileV15(profile: VoiceProfileV15): string[] {
  const errors: string[] = [];
  if (!profile.id.trim()) errors.push('profile id must not be empty');
  if (!profile.botId.trim()) errors.push('botId must not be empty');
  if (!profile.provider.trim()) errors.push('provider must not be empty');
  if (!profile.voiceId.trim()) errors.push('voiceId must not be empty');
  if (profile.rate < 0.5 || profile.rate > 2) errors.push('rate must be 0.5..2');
  if (profile.pitch < -12 || profile.pitch > 12) errors.push('pitch must be -12..12');
  if (!TTS_V15_QUALITIES.includes(profile.quality)) errors.push(`unknown quality: ${profile.quality}`);
  if (profile.maxChunkChars < 10 || profile.maxChunkChars > 1000) errors.push('maxChunkChars must be 10..1000');
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(profile.language)) errors.push(`language must look like a BCP-47 tag, got ${profile.language}`);
  return errors;
}

/** Step a profile's quality down (pipeline auto-degrade). */
export function voiceProfileStepDownV15(profile: VoiceProfileV15): VoiceProfileV15 {
  const next: TtsQualityV15 = profile.quality === 'high' ? 'fast' : 'minimal';
  return { ...profile, quality: next };
}

export function voiceProfileStepUpV15(profile: VoiceProfileV15): VoiceProfileV15 {
  const next: TtsQualityV15 = profile.quality === 'minimal' ? 'fast' : 'high';
  return { ...profile, quality: next };
}

export class VoiceProfileStoreV15 {
  private readonly profiles = new Map<string, VoiceProfileV15>();

  set(profile: VoiceProfileV15): void {
    const errors = validateVoiceProfileV15(profile);
    if (errors.length > 0) throw new Error(`invalid voice profile: ${errors.join('; ')}`);
    this.profiles.set(profile.botId, { ...profile });
  }

  get(botId: string): VoiceProfileV15 {
    return this.profiles.get(botId) ?? defaultVoiceProfileV15(botId);
  }

  remove(botId: string): boolean {
    return this.profiles.delete(botId);
  }

  list(): VoiceProfileV15[] {
    return [...this.profiles.values()].sort((a, b) => a.botId.localeCompare(b.botId));
  }

  count(): number {
    return this.profiles.size;
  }
}

/** One chunk of reply text, ready to synthesise. */
export interface TtsChunkV15 {
  index: number;
  text: string;
  /** True when the chunk ends a sentence. */
  sentenceEnd: boolean;
}

export function chunkTtsTextV15(text: string, maxChunkChars: number): TtsChunkV15[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Split at clause boundaries first, then pack greedily to the cap.
  const pieces = trimmed.split(/(?<=[,;:!?…。．.!?])\s+/).filter((p) => p.length > 0);
  const chunks: TtsChunkV15[] = [];
  let current = '';
  const flush = (sentenceEnd: boolean): void => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, text: current, sentenceEnd });
    current = '';
  };
  for (const piece of pieces) {
    const sentenceEnd = /[.!?…。]$/.test(piece.trim());
    if (current.length === 0) {
      if (piece.length <= maxChunkChars) {
        current = piece;
      } else {
        // Long piece: hard-split at word boundaries.
        const words = piece.split(/\s+/);
        for (const word of words) {
          if (current.length > 0 && current.length + 1 + word.length > maxChunkChars) flush(false);
          current = current.length === 0 ? word : `${current} ${word}`;
        }
        flush(sentenceEnd);
      }
      continue;
    }
    if (current.length + 1 + piece.length <= maxChunkChars) {
      current = `${current} ${piece}`;
      if (sentenceEnd) flush(true);
    } else {
      flush(/[.!?…。]$/.test(current.trim()));
      current = piece.length <= maxChunkChars ? piece : '';
      if (piece.length > maxChunkChars) {
        const words = piece.split(/\s+/);
        for (const word of words) {
          if (current.length > 0 && current.length + 1 + word.length > maxChunkChars) flush(false);
          current = current.length === 0 ? word : `${current} ${word}`;
        }
        flush(sentenceEnd);
      }
    }
  }
  flush(/[.!?…。]$/.test(current.trim()));
  return chunks;
}

/** Synthesised audio for one chunk (mock: synthetic PCM16). */
export interface TtsAudioChunkV15 {
  index: number;
  text: string;
  audio: Int16Array;
  /** Virtual ms from speak() to this chunk's audio. */
  atMs: number;
  synthMs: number;
}

export type TtsSynthV15 = (chunk: TtsChunkV15, profile: VoiceProfileV15) => { audio: Int16Array; synthMs: number };

/** Mock synth: deterministic PCM (a sine burst sized to the text) + scripted synth time. */
export function mockTtsSynthV15(chunk: TtsChunkV15, profile: VoiceProfileV15): { audio: Int16Array; synthMs: number } {
  const baseMs = profile.quality === 'high' ? 120 : profile.quality === 'fast' ? 60 : 30;
  const synthMs = baseMs + chunk.text.length * 2;
  const samples = Math.max(480, chunk.text.length * 24);
  const audio = new Int16Array(samples);
  const amplitude = 12000;
  for (let i = 0; i < samples; i += 1) {
    audio[i] = Math.round(amplitude * Math.sin((i / samples) * Math.PI * 6));
  }
  return { audio, synthMs };
}

export type TtsStreamStateV15 = 'idle' | 'speaking' | 'cancelled' | 'done';

export interface TtsStreamEventV15 {
  kind: 'started' | 'audio' | 'chunk-done' | 'cancelled' | 'done';
  atMs: number;
  chunk?: TtsAudioChunkV15;
  spokenChars?: number;
  cancelledChunks?: number;
}

export type TtsStreamSinkV15 = (event: TtsStreamEventV15) => void;

export interface TtsStreamStatsV15 {
  utterances: number;
  chunksSpoken: number;
  chunksCancelled: number;
  charactersSpoken: number;
  cancellations: number;
  firstAudioMs: number | undefined;
  averageFirstAudioMs: number;
}

interface PendingChunkV15 {
  chunk: TtsChunkV15;
  readyAtMs: number;
  audio: Int16Array;
  synthMs: number;
}

/**
 * One utterance, streamed chunk by chunk. `speak()` queues the
 * chunks; `tick(ms)` advances synthesis and emits audio events in
 * order. `cancel()` stops after the current chunk: already-emitted
 * chunks stay spoken, the rest are reported cancelled.
 */
export class TtsStreamV15 {
  private readonly synth: TtsSynthV15;
  private readonly sink: TtsStreamSinkV15 | undefined;
  private state: TtsStreamStateV15 = 'idle';
  private nowMs = 0;
  private profile: VoiceProfileV15 | undefined;
  private pending: PendingChunkV15[] = [];
  private currentText = '';
  private spokenChars = 0;
  private firstAudioAtMs: number | undefined;
  private speakStartedAtMs = 0;
  private utterances = 0;
  private chunksSpoken = 0;
  private chunksCancelled = 0;
  private charactersSpoken = 0;
  private cancellations = 0;
  private readonly firstAudioSamples: number[] = [];

  constructor(synth: TtsSynthV15 = mockTtsSynthV15, sink?: TtsStreamSinkV15) {
    this.synth = synth;
    this.sink = sink;
  }

  getState(): TtsStreamStateV15 {
    return this.state;
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }

  /** Start speaking `text` with `profile`. Returns the chunk list. */
  speak(text: string, profile: VoiceProfileV15, atMs?: number): TtsChunkV15[] {
    if (this.state === 'speaking') throw new Error('TTS stream is already speaking; cancel it first');
    const errors = validateVoiceProfileV15(profile);
    if (errors.length > 0) throw new Error(`invalid voice profile: ${errors.join('; ')}`);
    const chunks = chunkTtsTextV15(text, profile.maxChunkChars);
    if (chunks.length === 0) throw new Error('cannot speak empty text');
    if (atMs !== undefined) this.nowMs = atMs;
    this.profile = profile;
    this.currentText = text;
    this.spokenChars = 0;
    this.firstAudioAtMs = undefined;
    this.speakStartedAtMs = this.nowMs;
    this.pending = chunks.map((chunk) => {
      const { audio, synthMs } = this.synth(chunk, profile);
      return { chunk, readyAtMs: this.nowMs + synthMs, audio, synthMs };
    });
    // Chunks synthesise in sequence: each waits for the previous.
    let cursor = this.nowMs;
    for (const item of this.pending) {
      cursor += item.synthMs;
      item.readyAtMs = cursor;
    }
    this.state = 'speaking';
    this.utterances += 1;
    this.sink?.({ kind: 'started', atMs: this.nowMs });
    return chunks;
  }

  tick(ms: number): void {
    this.nowMs += ms;
    if (this.state !== 'speaking') return;
    while (this.pending.length > 0 && this.pending[0].readyAtMs <= this.nowMs) {
      const item = this.pending.shift() as PendingChunkV15;
      if (this.firstAudioAtMs === undefined) {
        this.firstAudioAtMs = this.nowMs - this.speakStartedAtMs;
        this.firstAudioSamples.push(this.firstAudioAtMs);
      }
      this.chunksSpoken += 1;
      this.charactersSpoken += item.chunk.text.length;
      this.spokenChars += item.chunk.text.length;
      this.sink?.({
        kind: 'audio',
        atMs: this.nowMs,
        chunk: { index: item.chunk.index, text: item.chunk.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs },
      });
      this.sink?.({ kind: 'chunk-done', atMs: this.nowMs, spokenChars: this.spokenChars });
    }
    if (this.pending.length === 0) {
      this.state = 'done';
      this.sink?.({ kind: 'done', atMs: this.nowMs, spokenChars: this.spokenChars });
    }
  }

  /** Cancel mid-stream. Returns chars spoken + chunks cancelled. */
  cancel(atMs?: number): { spokenChars: number; cancelledChunks: number; remainingText: string } {
    if (atMs !== undefined) this.nowMs = atMs;
    const cancelledChunks = this.pending.length;
    const remainingText = this.pending.map((p) => p.chunk.text).join(' ');
    this.pending = [];
    this.chunksCancelled += cancelledChunks;
    if (this.state === 'speaking') {
      this.state = 'cancelled';
      this.cancellations += 1;
    }
    this.sink?.({ kind: 'cancelled', atMs: this.nowMs, spokenChars: this.spokenChars, cancelledChunks });
    return { spokenChars: this.spokenChars, cancelledChunks, remainingText };
  }

  /** Text not yet spoken (for resume after a barge-in cut). */
  remainingText(): string {
    return this.pending.map((p) => p.chunk.text).join(' ');
  }

  spokenText(): string {
    return this.currentText.slice(0, this.spokenChars);
  }

  stats(): TtsStreamStatsV15 {
    return {
      utterances: this.utterances,
      chunksSpoken: this.chunksSpoken,
      chunksCancelled: this.chunksCancelled,
      charactersSpoken: this.charactersSpoken,
      cancellations: this.cancellations,
      firstAudioMs: this.firstAudioAtMs,
      averageFirstAudioMs: this.firstAudioSamples.length > 0
        ? Math.round(this.firstAudioSamples.reduce((a, b) => a + b, 0) / this.firstAudioSamples.length)
        : 0,
    };
  }

  summary(): string {
    const s = this.stats();
    return `tts v15: ${s.utterances} utterances, ${s.chunksSpoken} chunks spoken, ${s.chunksCancelled} cancelled, ` +
      `${s.charactersSpoken} chars, avg first-audio ${s.averageFirstAudioMs} ms`;
  }

  markdown(): string {
    const s = this.stats();
    return [
      '## TTS streaming v15',
      '',
      `- Utterances: ${s.utterances}; chunks spoken: ${s.chunksSpoken}; chunks cancelled: ${s.chunksCancelled}`,
      `- Characters spoken: ${s.charactersSpoken}; cancellations: ${s.cancellations}`,
      `- Average time to first audio: ${s.averageFirstAudioMs} ms`,
      '',
    ].join('\n');
  }
}

export function createTtsStreamV15(synth?: TtsSynthV15, sink?: TtsStreamSinkV15): TtsStreamV15 {
  return new TtsStreamV15(synth, sink);
}

export function ttsV15Summary(stream: TtsStreamV15): string {
  return stream.summary();
}

export function ttsV15Markdown(stream: TtsStreamV15): string {
  return stream.markdown();
}
