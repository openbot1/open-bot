/**
 * TTS streaming v2 (v1.17, Đội T5 — voice v16).
 *
 * v15 streamed clause by clause and measured time-to-first-audio.
 * v16 owns *how the audio reaches the ear*, because a stream that
 * stutters between chunks sounds worse than a slow one:
 *
 *   1. Small chunks. `maxChunkChars` defaults to 60 (half of v15)
 *      and the chunker splits at clause boundaries first, so the
 *      first chunk is ready — and playing — while the rest of the
 *      sentence is still being synthesised. First-audio latency is
 *      measured per utterance and reported.
 *   2. Play the first chunk as soon as it arrives. There is no
 *      "wait for two chunks before starting" rule: the playout
 *      scheduler starts the moment chunk 0 is ready, and later
 *      chunks queue behind it in a jitter buffer.
 *   3. Smooth joins between chunks. The scheduler lays chunks on
 *      a playout timeline: each chunk has a `playAtMs`, computed
 *      from the previous chunk's end minus a configurable
 *      `crossfadeMs` overlap, so joins are gapless by
 *      construction. The *measured* gap between consecutive
 *      chunks is recorded (a negative gap is an overlap, a
 *      positive gap is a stutter); the largest gap and the
 *      average gap are in the stats.
 *   4. Underrun detection + recovery. When the next chunk is not
 *      ready when the previous one ends, the scheduler counts an
 *      underrun, holds the line with a short silence pad
 *      (`underrunPadMs`), and resumes the moment the chunk lands
 *      — it never replays, never skips, and never stalls the
 *      utterance forever.
 *   5. Pause / resume and rate control. `pause()` freezes the
 *      playout clock (the remaining timeline shifts by the pause);
 *      `resume()` continues from the same chunk. Playback rate
 *      (from the voice profile) shortens or stretches every chunk
 *      duration, so a fast voice stays gapless too.
 *
 * The synth is injected (mock in tests, a real provider adapter in
 * production); the scheduler only ever sees ready-times and
 * durations. Virtual clock, no sound card.
 */

import { chunkTtsTextV15, mockTtsSynthV15 } from '../voiceV15/ttsStreamV15';
import type { TtsChunkV15, TtsSynthV15, VoiceProfileV15 } from '../voiceV15/ttsStreamV15';

export const TTS_V16_SAMPLE_RATE_HZ = 24000;
export const TTS_V16_DEFAULT_MAX_CHUNK_CHARS = 60;
export const TTS_V16_DEFAULT_CROSSFADE_MS = 15;
export const TTS_V16_DEFAULT_UNDERRUN_PAD_MS = 40;

export interface TtsStreamV16Options {
  /** Max characters per streamed chunk (default 60). */
  maxChunkChars?: number;
  /** Overlap (ms) scheduled between consecutive chunks (default 15). */
  crossfadeMs?: number;
  /** Silence pad (ms) inserted on an underrun (default 40). */
  underrunPadMs?: number;
  /** Jitter buffer: ms of audio to hold before starting playout (default 0 — first chunk plays at once). */
  playoutDelayMs?: number;
}

export function defaultTtsStreamV16Options(): Required<TtsStreamV16Options> {
  return {
    maxChunkChars: TTS_V16_DEFAULT_MAX_CHUNK_CHARS,
    crossfadeMs: TTS_V16_DEFAULT_CROSSFADE_MS,
    underrunPadMs: TTS_V16_DEFAULT_UNDERRUN_PAD_MS,
    playoutDelayMs: 0,
  };
}

export function validateTtsStreamV16Options(options: TtsStreamV16Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof TtsStreamV16Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('maxChunkChars', options.maxChunkChars, 10, 500);
  check('crossfadeMs', options.crossfadeMs, 0, 200);
  check('underrunPadMs', options.underrunPadMs, 0, 1000);
  check('playoutDelayMs', options.playoutDelayMs, 0, 2000);
  return errors;
}

/** One scheduled chunk on the playout timeline. */
export interface TtsPlayItemV16 {
  index: number;
  text: string;
  audio: Int16Array;
  synthMs: number;
  /** Virtual ms the chunk becomes ready (synth done). */
  readyAtMs: number;
  /** Virtual ms playout of this chunk starts. */
  playAtMs: number;
  /** Playout duration (ms), rate-adjusted. */
  durationMs: number;
}

export type TtsStreamV16State = 'idle' | 'speaking' | 'paused' | 'cancelled' | 'done';

export type TtsStreamV16EventKind =
  | 'started'
  | 'first-audio'
  | 'audio'
  | 'chunk-done'
  | 'underrun'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'done';

export interface TtsStreamV16Event {
  kind: TtsStreamV16EventKind;
  atMs: number;
  chunk?: { index: number; text: string; audio: Int16Array; atMs: number; synthMs: number };
  /** Gap (ms) between the previous chunk's end and this chunk's start. Negative = overlap. */
  gapMs?: number;
  spokenChars?: number;
  cancelledChunks?: number;
}

export type TtsStreamV16Sink = (event: TtsStreamV16Event) => void;

export interface TtsStreamV16Stats {
  utterances: number;
  chunksSpoken: number;
  chunksCancelled: number;
  charactersSpoken: number;
  cancellations: number;
  firstAudioMs: number | undefined;
  averageFirstAudioMs: number;
  /** Gaps (ms) between consecutive chunks; negative = crossfade overlap. */
  gapsMs: number[];
  maxGapMs: number | undefined;
  averageGapMs: number;
  underruns: number;
  pauses: number;
  /** ms of audio still queued (jitter buffer depth). */
  bufferedMs: number;
}

/** Duration of synthetic audio at the profile rate (ms). */
export function ttsChunkDurationMsV16(audio: Int16Array, rate: number): number {
  const rawMs = (audio.length / TTS_V16_SAMPLE_RATE_HZ) * 1000;
  return Math.max(20, Math.round(rawMs / Math.max(0.5, rate)));
}

/**
 * One utterance, streamed through a gapless playout scheduler.
 * `speak()` synthesises every chunk up front (the mock synth is
 * instant; a real synth fills `readyAtMs` per chunk) and lays them
 * on the timeline; `tick(ms)` plays whatever is due. `cancel()`
 * stops after the current chunk and reports the cut point.
 */
export class TtsStreamV16 {
  private readonly synth: TtsSynthV15;
  private readonly options: Required<TtsStreamV16Options>;
  private readonly sink: TtsStreamV16Sink | undefined;
  private state: TtsStreamV16State = 'idle';
  private nowMs = 0;
  private profile: VoiceProfileV15 | undefined;
  private timeline: TtsPlayItemV16[] = [];
  private playCursor = 0;
  private playingUntilMs = 0;
  private lastChunkEndMs: number | undefined;
  private currentText = '';
  private spokenChars = 0;
  private firstAudioAtMs: number | undefined;
  private speakStartedAtMs = 0;
  private utterances = 0;
  private chunksSpoken = 0;
  private chunksCancelled = 0;
  private charactersSpoken = 0;
  private cancellations = 0;
  private pauses = 0;
  private readonly firstAudioSamples: number[] = [];
  private readonly gapsMs: number[] = [];
  private underruns = 0;
  private pausedAtMs: number | undefined;

  constructor(synth: TtsSynthV15 = mockTtsSynthV15, options: TtsStreamV16Options = {}, sink?: TtsStreamV16Sink) {
    const merged = { ...defaultTtsStreamV16Options(), ...options };
    const errors = validateTtsStreamV16Options(merged);
    if (errors.length > 0) throw new Error(`invalid TTS stream v16 options: ${errors.join('; ')}`);
    this.synth = synth;
    this.options = merged;
    this.sink = sink;
  }

  getState(): TtsStreamV16State {
    return this.state;
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }

  isPaused(): boolean {
    return this.state === 'paused';
  }

  /** Start speaking `text` with `profile`. Returns the chunk list. */
  speak(text: string, profile: VoiceProfileV15, atMs?: number): TtsChunkV15[] {
    if (this.state === 'speaking' || this.state === 'paused') {
      throw new Error('TTS stream v16 is already speaking; cancel it first');
    }
    const chunks = chunkTtsTextV15(text, Math.min(profile.maxChunkChars, this.options.maxChunkChars));
    if (chunks.length === 0) throw new Error('cannot speak empty text');
    if (atMs !== undefined) this.nowMs = atMs;
    this.profile = profile;
    this.currentText = text;
    this.spokenChars = 0;
    this.firstAudioAtMs = undefined;
    this.speakStartedAtMs = this.nowMs;
    this.playCursor = 0;
    this.lastChunkEndMs = undefined;
    this.playingUntilMs = 0;
    this.pausedAtMs = undefined;
    // Synthesise in sequence; each chunk is ready after its synth
    // time *plus* the previous chunk's synth time (one synth at a
    // time, like a real streaming provider).
    let synthCursor = this.nowMs;
    let playCursor = this.nowMs + this.options.playoutDelayMs;
    this.timeline = chunks.map((chunk) => {
      const { audio, synthMs } = this.synth(chunk, profile);
      synthCursor += synthMs;
      const durationMs = ttsChunkDurationMsV16(audio, profile.rate);
      const item: TtsPlayItemV16 = {
        index: chunk.index,
        text: chunk.text,
        audio,
        synthMs,
        readyAtMs: synthCursor,
        playAtMs: playCursor,
        durationMs,
      };
      // Next chunk starts when this one ends, minus the crossfade
      // overlap — the join is gapless by construction.
      playCursor = playCursor + durationMs - this.options.crossfadeMs;
      return item;
    });
    this.state = 'speaking';
    this.utterances += 1;
    this.sink?.({ kind: 'started', atMs: this.nowMs });
    return chunks;
  }

  tick(ms: number): void {
    this.nowMs += ms;
    if (this.state !== 'speaking') return;
    while (this.playCursor < this.timeline.length) {
      const item = this.timeline[this.playCursor];
      if (this.nowMs < item.playAtMs) return;
      if (this.nowMs < item.readyAtMs) {
        // The chunk is not synthesised yet. For the first chunk
        // that is normal startup (wait, do not count an underrun);
        // after the first chunk it is an underrun: hold the line,
        // shift the remaining timeline to the ready time plus the
        // silence pad, and resume when the chunk lands.
        const shift = item.readyAtMs - item.playAtMs + (this.playCursor > 0 ? this.options.underrunPadMs : 0);
        if (this.playCursor > 0) {
          this.underruns += 1;
          this.sink?.({ kind: 'underrun', atMs: this.nowMs, chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs } });
        }
        for (let i = this.playCursor; i < this.timeline.length; i += 1) {
          this.timeline[i].playAtMs += shift;
        }
        return;
      }
      const gapMs = this.lastChunkEndMs !== undefined ? item.playAtMs - this.lastChunkEndMs : 0;
      if (this.playCursor > 0) this.gapsMs.push(gapMs);
      if (this.firstAudioAtMs === undefined) {
        this.firstAudioAtMs = this.nowMs - this.speakStartedAtMs;
        this.firstAudioSamples.push(this.firstAudioAtMs);
        this.sink?.({ kind: 'first-audio', atMs: this.nowMs, chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs }, gapMs });
      }
      this.chunksSpoken += 1;
      this.charactersSpoken += item.text.length;
      this.spokenChars += item.text.length;
      // The chunk ends at its *scheduled* end, not nowMs + duration:
      // when a tick jumps far past the schedule, nowMs-based ends
      // would claim the chunk is still playing forever.
      this.playingUntilMs = item.playAtMs + item.durationMs;
      this.lastChunkEndMs = item.playAtMs + item.durationMs;
      this.playCursor += 1;
      this.sink?.({
        kind: 'audio',
        atMs: this.nowMs,
        chunk: { index: item.index, text: item.text, audio: item.audio, atMs: this.nowMs, synthMs: item.synthMs },
        gapMs,
      });
      this.sink?.({ kind: 'chunk-done', atMs: this.nowMs, spokenChars: this.spokenChars });
    }
    this.finishIfDone();
  }

  /** Freeze the playout clock; the remaining timeline shifts. */
  pause(atMs?: number): void {
    if (this.state !== 'speaking') return;
    if (atMs !== undefined) this.nowMs = atMs;
    this.pausedAtMs = this.nowMs;
    this.state = 'paused';
    this.pauses += 1;
    this.sink?.({ kind: 'paused', atMs: this.nowMs, spokenChars: this.spokenChars });
  }

  /** Continue from the same chunk after a pause. */
  resume(atMs?: number): void {
    if (this.state !== 'paused' || this.pausedAtMs === undefined) return;
    if (atMs !== undefined) this.nowMs = atMs;
    const pausedFor = this.nowMs - this.pausedAtMs;
    for (const item of this.timeline) {
      item.playAtMs += pausedFor;
      item.readyAtMs += pausedFor;
    }
    if (this.lastChunkEndMs !== undefined) this.lastChunkEndMs += pausedFor;
    this.playingUntilMs += pausedFor;
    this.pausedAtMs = undefined;
    this.state = 'speaking';
    this.sink?.({ kind: 'resumed', atMs: this.nowMs, spokenChars: this.spokenChars });
  }

  /** Cancel mid-stream. Returns chars spoken + chunks cancelled. */
  cancel(atMs?: number): { spokenChars: number; cancelledChunks: number; remainingText: string } {
    if (atMs !== undefined) this.nowMs = atMs;
    const remaining = this.timeline.slice(this.playCursor);
    const remainingText = remaining.map((item) => item.text).join(' ');
    const cancelledChunks = remaining.length;
    this.timeline = this.timeline.slice(0, this.playCursor);
    this.chunksCancelled += cancelledChunks;
    if (this.state === 'speaking' || this.state === 'paused') {
      this.state = 'cancelled';
      this.cancellations += 1;
    }
    this.sink?.({ kind: 'cancelled', atMs: this.nowMs, spokenChars: this.spokenChars, cancelledChunks });
    return { spokenChars: this.spokenChars, cancelledChunks, remainingText };
  }

  /** Text not yet spoken (for resume after a barge-in cut). */
  remainingText(): string {
    return this.timeline.slice(this.playCursor).map((item) => item.text).join(' ');
  }

  spokenText(): string {
    return this.currentText.slice(0, this.spokenChars);
  }

  /** Scheduled play times (for tests / diagnostics). */
  schedule(): { index: number; text: string; playAtMs: number; durationMs: number; readyAtMs: number }[] {
    return this.timeline.map((item) => ({
      index: item.index,
      text: item.text,
      playAtMs: item.playAtMs,
      durationMs: item.durationMs,
      readyAtMs: item.readyAtMs,
    }));
  }

  stats(): TtsStreamV16Stats {
    const bufferedMs = this.timeline.slice(this.playCursor).reduce((sum, item) => sum + item.durationMs, 0);
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
      gapsMs: [...this.gapsMs],
      maxGapMs: this.gapsMs.length > 0 ? Math.max(...this.gapsMs) : undefined,
      averageGapMs: this.gapsMs.length > 0
        ? Math.round(this.gapsMs.reduce((a, b) => a + b, 0) / this.gapsMs.length)
        : 0,
      underruns: this.underruns,
      pauses: this.pauses,
      bufferedMs,
    };
  }

  summary(): string {
    const s = this.stats();
    return `tts v16: ${s.utterances} utterances, ${s.chunksSpoken} chunks spoken, ${s.chunksCancelled} cancelled, ` +
      `${s.charactersSpoken} chars, avg first-audio ${s.averageFirstAudioMs} ms, ` +
      `max gap ${s.maxGapMs !== undefined ? `${s.maxGapMs} ms` : 'n/a'}, ${s.underruns} underruns`;
  }

  markdown(): string {
    const s = this.stats();
    return [
      '## TTS streaming v16',
      '',
      `- Utterances: ${s.utterances}; chunks spoken: ${s.chunksSpoken}; chunks cancelled: ${s.chunksCancelled}`,
      `- Characters spoken: ${s.charactersSpoken}; cancellations: ${s.cancellations}`,
      `- Average time to first audio: ${s.averageFirstAudioMs} ms`,
      `- Join gaps between chunks: max ${s.maxGapMs !== undefined ? `${s.maxGapMs} ms` : 'n/a'}, average ${s.averageGapMs} ms (negative = crossfade overlap)`,
      `- Underruns: ${s.underruns}; pauses: ${s.pauses}; buffered audio: ${s.bufferedMs} ms`,
      '',
    ].join('\n');
  }

  private finishIfDone(): void {
    if (this.state !== 'speaking') return;
    if (this.playCursor < this.timeline.length) return;
    if (this.nowMs < this.playingUntilMs) return;
    this.state = 'done';
    this.sink?.({ kind: 'done', atMs: this.nowMs, spokenChars: this.spokenChars });
  }
}

export function createTtsStreamV16(
  synth?: TtsSynthV15,
  options?: TtsStreamV16Options,
  sink?: TtsStreamV16Sink,
): TtsStreamV16 {
  return new TtsStreamV16(synth, options, sink);
}

export function ttsV16Summary(stream: TtsStreamV16): string {
  return stream.summary();
}

export function ttsV16Markdown(stream: TtsStreamV16): string {
  return stream.markdown();
}
