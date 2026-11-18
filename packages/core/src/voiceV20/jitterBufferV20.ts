/**
 * Jitter buffer v20 (voice v20, v1.28 Team T5).
 *
 * Realtime voice arrives in 20 ms frames that are out of order,
 * late, duplicated, or missing entirely. The jitter buffer absorbs
 * that: frames are held for a short target delay, released in
 * sequence-number order, and gaps are concealed (repeat the last
 * good frame once, then silence) so the VAD and the transcript
 * pipeline downstream always see a steady, gapless stream.
 *
 * Pure frame bookkeeping, virtual clock, mock/synthetic audio only.
 * No network, no sound card, no key.
 */
import {
  pcm16RmsV20,
  silentFrameV20,
  VOICE_V20_FRAME_MS,
  VOICE_V20_FRAME_SAMPLES,
  type VoiceV20Frame,
} from './types';

export type JitterBufferV20Decision = 'accepted' | 'duplicate' | 'too-late' | 'overflow';
export type JitterBufferV20Concealment = 'repeat' | 'silence';
export type JitterBufferV20EventKind =
  | 'gap'
  | 'late-frame'
  | 'duplicate-frame'
  | 'overflow'
  | 'underrun'
  | 'concealed';
export type JitterBufferV20Event = {
  kind: JitterBufferV20EventKind;
  atMs: number;
  detail?: Record<string, unknown>;
};
export type JitterBufferV20EventSink = (event: JitterBufferV20Event) => void;

export interface JitterBufferV20Options {
  /** Target hold time before a frame is released, in ms. */
  targetDelayMs: number;
  /** Max frames held; beyond this the oldest are dropped. */
  maxBufferedFrames: number;
  /** Frames older than this (behind the playhead) are too late. */
  maxLateMs: number;
  /** How many times the last good frame may be repeated to cover a gap. */
  maxRepeatConcealments: number;
  /** Emit a concealment event for every concealed frame. */
  emitConcealmentEvents: boolean;
}

export function defaultJitterBufferV20Options(): JitterBufferV20Options {
  return {
    targetDelayMs: 60,
    maxBufferedFrames: 50,
    maxLateMs: 200,
    maxRepeatConcealments: 2,
    emitConcealmentEvents: true,
  };
}

export function validateJitterBufferV20Options(o: Partial<JitterBufferV20Options>): string[] {
  const e: string[] = [];
  if (o.targetDelayMs !== undefined && o.targetDelayMs < 0) e.push('targetDelayMs must be >= 0');
  if (o.targetDelayMs !== undefined && o.targetDelayMs > 2000) e.push('targetDelayMs must be <= 2000');
  if (o.maxBufferedFrames !== undefined && o.maxBufferedFrames < 1) e.push('maxBufferedFrames must be >= 1');
  if (o.maxLateMs !== undefined && o.maxLateMs < 0) e.push('maxLateMs must be >= 0');
  if (o.maxRepeatConcealments !== undefined && o.maxRepeatConcealments < 0) e.push('maxRepeatConcealments must be >= 0');
  if (o.maxRepeatConcealments !== undefined && o.maxRepeatConcealments > 10) e.push('maxRepeatConcealments must be <= 10');
  return e;
}

export interface JitterBufferV20Stats {
  received: number;
  accepted: number;
  duplicates: number;
  tooLate: number;
  overflowDropped: number;
  released: number;
  gaps: number;
  concealedFrames: number;
  underruns: number;
  maxJitterMs: number;
  maxBuffered: number;
  currentBuffered: number;
  nextExpectedSeq: number | null;
}

export interface JitterBufferV20Release {
  frame: VoiceV20Frame;
  /** True when the frame is synthetic concealment, not real audio. */
  concealed: boolean;
  concealment?: JitterBufferV20Concealment;
  /** How late this frame was vs its scheduled release, in ms. */
  latenessMs: number;
}

/** Inter-arrival jitter estimate for one frame pair, in ms. */
export function jitterMsV20(prevAtMs: number, atMs: number, expectedGapMs = VOICE_V20_FRAME_MS): number {
  return Math.abs(atMs - prevAtMs - expectedGapMs);
}

/** True when a frame's sequence number is already behind the playhead. */
export function isTooLateV20(seq: number, nextExpectedSeq: number | null, maxLateFrames: number): boolean {
  if (nextExpectedSeq === null) return false;
  return seq < nextExpectedSeq - maxLateFrames;
}

export class JitterBufferV20 {
  private opts: JitterBufferV20Options;
  private sink?: JitterBufferV20EventSink;
  private held = new Map<number, VoiceV20Frame>();
  private nextSeq: number | null = null;
  /** Sequence / arrival time of the first frame ever pushed: anchors the 20ms grid. */
  private anchorSeq: number | null = null;
  private anchorAtMs: number | null = null;
  private lastReleasedAtMs: number | null = null;
  private lastReleasedFrame: VoiceV20Frame | null = null;
  private lastArrivalAtMs: number | null = null;
  private repeatCount = 0;
  private stats: JitterBufferV20Stats = {
    received: 0, accepted: 0, duplicates: 0, tooLate: 0, overflowDropped: 0,
    released: 0, gaps: 0, concealedFrames: 0, underruns: 0, maxJitterMs: 0,
    maxBuffered: 0, currentBuffered: 0, nextExpectedSeq: null,
  };

  constructor(opts: Partial<JitterBufferV20Options> = {}, sink?: JitterBufferV20EventSink) {
    this.opts = { ...defaultJitterBufferV20Options(), ...opts };
    this.sink = sink;
  }

  get options(): JitterBufferV20Options { return { ...this.opts }; }
  get buffered(): number { return this.held.size; }
  get nextExpectedSeq(): number | null { return this.nextSeq; }
  getStats(): JitterBufferV20Stats {
    return { ...this.stats, currentBuffered: this.held.size, nextExpectedSeq: this.nextSeq };
  }

  push(frame: VoiceV20Frame): JitterBufferV20Decision {
    this.stats.received += 1;
    if (this.lastArrivalAtMs !== null) {
      const j = jitterMsV20(this.lastArrivalAtMs, frame.atMs);
      if (j > this.stats.maxJitterMs) this.stats.maxJitterMs = j;
    }
    this.lastArrivalAtMs = frame.atMs;
    if (this.held.has(frame.seq)) {
      this.stats.duplicates += 1;
      this.sink?.({ kind: 'duplicate-frame', atMs: frame.atMs, detail: { seq: frame.seq } });
      return 'duplicate';
    }
    const maxLateFrames = Math.max(1, Math.floor(this.opts.maxLateMs / VOICE_V20_FRAME_MS));
    if (this.nextSeq !== null && frame.seq < this.nextSeq - maxLateFrames) {
      this.stats.tooLate += 1;
      this.sink?.({ kind: 'late-frame', atMs: frame.atMs, detail: { seq: frame.seq, nextSeq: this.nextSeq } });
      return 'too-late';
    }
    if (this.held.size >= this.opts.maxBufferedFrames) {
      // Drop the oldest held frame to make room; never drop the playhead.
      const oldest = Math.min(...this.held.keys());
      this.held.delete(oldest);
      this.stats.overflowDropped += 1;
      this.sink?.({ kind: 'overflow', atMs: frame.atMs, detail: { droppedSeq: oldest, seq: frame.seq } });
    }
    this.held.set(frame.seq, frame);
    this.stats.accepted += 1;
    if (this.held.size > this.stats.maxBuffered) this.stats.maxBuffered = this.held.size;
    if (this.nextSeq === null) {
      this.nextSeq = frame.seq;
      this.anchorSeq = frame.seq;
      this.anchorAtMs = frame.atMs;
    }
    return 'accepted';
  }

  /**
   * Release every frame whose scheduled time (arrival + target delay)
   * has passed, in sequence order. A missing sequence number is
   * concealed once (repeat) or with silence, then skipped.
   */
  popDue(nowMs: number): JitterBufferV20Release[] {
    const out: JitterBufferV20Release[] = [];
    if (this.nextSeq === null) return out;
    for (;;) {
      const frame = this.held.get(this.nextSeq);
      if (!frame) {
        // Gap: nothing held for the expected sequence.
        if (this.lastReleasedFrame === null) {
          // Nothing ever released — cannot conceal yet; wait for data.
          this.stats.underruns += 1;
          this.sink?.({ kind: 'underrun', atMs: nowMs, detail: { seq: this.nextSeq } });
          return out;
        }
        // Never conceal a frame before its scheduled release time:
        // on the 20ms grid it is due at anchorAtMs + (seq - anchorSeq)
        // frames + targetDelay. Until then it may still arrive.
        if (this.anchorSeq !== null && this.anchorAtMs !== null) {
          const expectedAtMs = this.anchorAtMs + (this.nextSeq - this.anchorSeq) * VOICE_V20_FRAME_MS;
          if (nowMs < expectedAtMs + this.opts.targetDelayMs) return out;
        }
        this.stats.gaps += 1;
        const concealed = this.concealFrame(this.nextSeq, nowMs);
        out.push(concealed);
        this.nextSeq += 1;
        // Only conceal a bounded run, then stop and wait for real frames.
        if (out.filter((r) => r.concealed).length >= this.opts.maxRepeatConcealments + 1) return out;
        continue;
      }
      if (frame.atMs + this.opts.targetDelayMs > nowMs) return out;
      this.held.delete(this.nextSeq);
      const lateness = Math.max(0, nowMs - (frame.atMs + this.opts.targetDelayMs));
      out.push({ frame, concealed: false, latenessMs: lateness });
      this.lastReleasedFrame = frame;
      this.lastReleasedAtMs = frame.atMs;
      this.repeatCount = 0;
      this.stats.released += 1;
      this.nextSeq += 1;
    }
  }

  private concealFrame(seq: number, nowMs: number): JitterBufferV20Release {
    this.stats.concealedFrames += 1;
    let frame: VoiceV20Frame;
    let mode: JitterBufferV20Concealment;
    if (this.repeatCount < this.opts.maxRepeatConcealments && this.lastReleasedFrame) {
      // Repeat the last good frame at reduced energy so a gap sounds
      // like a held vowel, not a click.
      const src = this.lastReleasedFrame.samples;
      const samples = new Int16Array(src.length);
      for (let i = 0; i < src.length; i += 1) samples[i] = Math.trunc(src[i] * 0.6);
      frame = { seq, atMs: nowMs, samples, energy: (this.lastReleasedFrame.energy ?? 0) * 0.6 };
      mode = 'repeat';
      this.repeatCount += 1;
    } else {
      frame = silentFrameV20(seq, nowMs);
      mode = 'silence';
    }
    this.lastReleasedFrame = frame;
    if (this.opts.emitConcealmentEvents) {
      this.sink?.({ kind: 'concealed', atMs: nowMs, detail: { seq, mode } });
    }
    this.sink?.({ kind: 'gap', atMs: nowMs, detail: { seq, mode } });
    return { frame, concealed: true, concealment: mode, latenessMs: 0 };
  }

  /** Drain everything held, in order, ignoring the target delay. */
  flush(): JitterBufferV20Release[] {
    const out: JitterBufferV20Release[] = [];
    if (this.nextSeq === null) return out;
    const seqs = [...this.held.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const frame = this.held.get(seq);
      if (!frame) continue;
      this.held.delete(seq);
      out.push({ frame, concealed: false, latenessMs: 0 });
      this.lastReleasedFrame = frame;
      this.stats.released += 1;
    }
    this.nextSeq = seqs.length > 0 ? seqs[seqs.length - 1] + 1 : this.nextSeq;
    return out;
  }

  reset(): void {
    this.held.clear();
    this.nextSeq = null;
    this.anchorSeq = null;
    this.anchorAtMs = null;
    this.lastReleasedAtMs = null;
    this.lastReleasedFrame = null;
    this.lastArrivalAtMs = null;
    this.repeatCount = 0;
  }

  /** RMS energy of the most recently released frame, 0 when none. */
  lastReleasedRms(): number {
    return this.lastReleasedFrame ? pcm16RmsV20(this.lastReleasedFrame.samples) : 0;
  }
}

export function createJitterBufferV20(
  opts: Partial<JitterBufferV20Options> = {},
  sink?: JitterBufferV20EventSink,
): JitterBufferV20 {
  return new JitterBufferV20(opts, sink);
}

export function jitterBufferV20Summary(b: JitterBufferV20): string {
  const s = b.getStats();
  return `Jitter buffer v20: ${s.released} released, ${s.gaps} gaps (${s.concealedFrames} concealed), ` +
    `${s.duplicates} duplicates, ${s.tooLate} too late, ${s.overflowDropped} overflow, ` +
    `max jitter ${s.maxJitterMs}ms, buffered ${s.currentBuffered}`;
}

export function jitterBufferV20Markdown(b: JitterBufferV20): string {
  const s = b.getStats();
  return `# Jitter Buffer v20\n\n- Received: ${s.received}\n- Released: ${s.released}\n- Gaps: ${s.gaps}\n` +
    `- Concealed frames: ${s.concealedFrames}\n- Duplicates: ${s.duplicates}\n` +
    `- Too late: ${s.tooLate}\n- Overflow dropped: ${s.overflowDropped}\n` +
    `- Underruns: ${s.underruns}\n- Max jitter: ${s.maxJitterMs}ms\n- Max buffered: ${s.maxBuffered}\n`;
}

export { VOICE_V20_FRAME_MS, VOICE_V20_FRAME_SAMPLES };
