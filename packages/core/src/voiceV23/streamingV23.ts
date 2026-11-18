/**
 * Adaptive realtime streaming for voice v23 (v1.36, Team T5).
 *
 * v20 shipped a fixed jitter buffer; v23 adapts. The buffer
 * target follows the measured network instead of a constant:
 * when jitter rises the target grows (fewer underruns, a
 * little more latency), when the network calms down it
 * shrinks again (lower latency). Every adaptation is logged
 * with its reason so a latency regression can be traced to
 * the network measurement that caused it, not guessed.
 *
 * Frames are the same 20 ms PCM16 shape as v22
 * (`VoiceV22Frame`); the buffer stores them by sequence
 * number, drops duplicates, counts late/duplicate frames,
 * and reports underruns (playout starved) and overruns
 * (buffer full, oldest dropped).
 *
 * All virtual-clock: `atMs` is supplied by the caller, never
 * read from the wall clock. No audio device is touched.
 */
import type { VoiceV23StreamFrame } from './types';
import { clampV23, meanV23, percentileV23, round2V23, VOICE_V23_FRAME_MS } from './types';

export interface AdaptiveBufferV23Options {
  /** Starting target buffer depth, ms (default 120). */
  baseTargetMs: number;
  /** Minimum target depth, ms (default 40). */
  minTargetMs: number;
  /** Maximum target depth, ms (default 400). */
  maxTargetMs: number;
  /** ms of target added per ms of measured jitter p95 (default 1.5). */
  jitterGain: number;
  /** EWMA alpha for the jitter estimate (default 0.2). */
  jitterAlpha: number;
  /** Buffer capacity in frames (default 50 = 1000 ms). */
  capacityFrames: number;
  /** Frames below this count count as "starving" (default 2). */
  starveFrames: number;
}

export function defaultAdaptiveBufferV23Options(): AdaptiveBufferV23Options {
  return {
    baseTargetMs: 120,
    minTargetMs: 40,
    maxTargetMs: 400,
    jitterGain: 1.5,
    jitterAlpha: 0.2,
    capacityFrames: 50,
    starveFrames: 2,
  };
}

export function validateAdaptiveBufferV23Options(o: Partial<AdaptiveBufferV23Options>): string[] {
  const errors: string[] = [];
  const check = (name: keyof AdaptiveBufferV23Options, min: number, max: number): void => {
    const v = o[name];
    if (v !== undefined && !(v >= min && v <= max)) errors.push(`${name} must be ${min}..${max}`);
  };
  check('baseTargetMs', 20, 1000);
  check('minTargetMs', 20, 1000);
  check('maxTargetMs', 20, 2000);
  check('jitterGain', 0, 10);
  check('jitterAlpha', 0.01, 1);
  check('capacityFrames', 5, 500);
  check('starveFrames', 0, 20);
  if (o.minTargetMs !== undefined && o.maxTargetMs !== undefined && o.minTargetMs > o.maxTargetMs) {
    errors.push('minTargetMs must not exceed maxTargetMs');
  }
  return errors;
}

export interface VoiceV23BufferStats {
  pushed: number;
  played: number;
  droppedDuplicate: number;
  droppedLate: number;
  droppedOverrun: number;
  underruns: number;
  overruns: number;
  bufferedFrames: number;
  bufferedMs: number;
  targetMs: number;
  jitterMs: number;
  jitterP95Ms: number;
  adaptations: number;
  lastAdaptationAtMs: number | null;
  lastAdaptationReason: string;
}

export interface VoiceV23BufferAdaptation {
  atMs: number;
  fromMs: number;
  toMs: number;
  jitterMs: number;
  reason: string;
}

/**
 * Adaptive jitter buffer: push frames in arrival order, pull
 * them in sequence order for playout. The target depth adapts
 * to the measured jitter on every push.
 */
export class AdaptiveJitterBufferV23 {
  private readonly opts: AdaptiveBufferV23Options;
  private readonly frames = new Map<number, VoiceV23StreamFrame>();
  private nextSeq: number | null = null;
  private lastArrivalAtMs: number | null = null;
  private jitterEwmaMs = 0;
  private readonly jitterSamples: number[] = [];
  private targetMs: number;
  private pushed = 0;
  private played = 0;
  private droppedDuplicate = 0;
  private droppedLate = 0;
  private droppedOverrun = 0;
  private underruns = 0;
  private overruns = 0;
  private readonly adaptations: VoiceV23BufferAdaptation[] = [];

  constructor(opts: Partial<AdaptiveBufferV23Options> = {}) {
    const errors = validateAdaptiveBufferV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid AdaptiveBufferV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultAdaptiveBufferV23Options(), ...opts };
    this.targetMs = this.opts.baseTargetMs;
  }

  options(): AdaptiveBufferV23Options {
    return { ...this.opts };
  }

  targetBufferMs(): number {
    return this.targetMs;
  }

  bufferedFrames(): number {
    return this.frames.size;
  }

  bufferedMs(): number {
    return this.frames.size * VOICE_V23_FRAME_MS;
  }

  /** Push one frame. Returns false when the frame was dropped. */
  push(frame: VoiceV23StreamFrame): boolean {
    this.pushed += 1;
    if (this.frames.has(frame.seq)) {
      this.droppedDuplicate += 1;
      return false;
    }
    if (this.nextSeq !== null && frame.seq < this.nextSeq) {
      this.droppedLate += 1;
      return false;
    }
    // Measure inter-arrival jitter against the nominal frame time.
    if (this.lastArrivalAtMs !== null) {
      const gap = frame.atMs - this.lastArrivalAtMs;
      const deviation = Math.abs(gap - VOICE_V23_FRAME_MS);
      this.jitterEwmaMs = this.opts.jitterAlpha * deviation + (1 - this.opts.jitterAlpha) * this.jitterEwmaMs;
      this.jitterSamples.push(deviation);
      if (this.jitterSamples.length > 200) this.jitterSamples.shift();
    }
    this.lastArrivalAtMs = frame.atMs;
    this.frames.set(frame.seq, frame);
    if (this.frames.size > this.opts.capacityFrames) {
      // Overrun: drop the oldest frame to make room.
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
      this.droppedOverrun += 1;
      this.overruns += 1;
      if (this.nextSeq === oldest) this.nextSeq = oldest + 1;
    }
    this.adaptTarget(frame.atMs);
    return true;
  }

  /** Pull the next frame in sequence order, or null when starved. */
  pull(atMs: number): VoiceV23StreamFrame | null {
    if (this.nextSeq === null) {
      if (this.frames.size === 0) {
        this.underruns += 1;
        return null;
      }
      this.nextSeq = Math.min(...this.frames.keys());
    }
    const frame = this.frames.get(this.nextSeq) ?? null;
    if (frame === null) {
      // Gap in the sequence: the frame never arrived (yet).
      if (this.frames.size <= this.opts.starveFrames) this.underruns += 1;
      return null;
    }
    this.frames.delete(this.nextSeq);
    this.nextSeq += 1;
    this.played += 1;
    void atMs;
    return frame;
  }

  /** True when enough frames are buffered to start playout. */
  readyToPlay(): boolean {
    return this.bufferedMs() >= this.targetMs;
  }

  jitterMs(): number {
    return round2V23(this.jitterEwmaMs);
  }

  jitterP95Ms(): number {
    return round2V23(percentileV23(this.jitterSamples, 95));
  }

  adaptationsHistory(): VoiceV23BufferAdaptation[] {
    return [...this.adaptations];
  }

  stats(): VoiceV23BufferStats {
    const last = this.adaptations[this.adaptations.length - 1] ?? null;
    return {
      pushed: this.pushed,
      played: this.played,
      droppedDuplicate: this.droppedDuplicate,
      droppedLate: this.droppedLate,
      droppedOverrun: this.droppedOverrun,
      underruns: this.underruns,
      overruns: this.overruns,
      bufferedFrames: this.frames.size,
      bufferedMs: this.bufferedMs(),
      targetMs: this.targetMs,
      jitterMs: this.jitterMs(),
      jitterP95Ms: this.jitterP95Ms(),
      adaptations: this.adaptations.length,
      lastAdaptationAtMs: last?.atMs ?? null,
      lastAdaptationReason: last?.reason ?? '',
    };
  }

  summary(): string {
    const s = this.stats();
    return `adaptive buffer: target ${s.targetMs}ms, buffered ${s.bufferedMs}ms, jitter ${s.jitterMs}ms (p95 ${s.jitterP95Ms}ms), underruns ${s.underruns}, overruns ${s.overruns}, dropped ${s.droppedDuplicate + s.droppedLate + s.droppedOverrun}`;
  }

  reset(): void {
    this.frames.clear();
    this.nextSeq = null;
    this.lastArrivalAtMs = null;
    this.jitterEwmaMs = 0;
    this.jitterSamples.length = 0;
    this.targetMs = this.opts.baseTargetMs;
    this.pushed = 0;
    this.played = 0;
    this.droppedDuplicate = 0;
    this.droppedLate = 0;
    this.droppedOverrun = 0;
    this.underruns = 0;
    this.overruns = 0;
    this.adaptations.length = 0;
  }

  private adaptTarget(atMs: number): void {
    const wanted = clampV23(
      this.opts.baseTargetMs + this.opts.jitterGain * this.jitterP95Ms(),
      this.opts.minTargetMs,
      this.opts.maxTargetMs,
    );
    const rounded = Math.round(wanted);
    if (rounded === this.targetMs) return;
    const from = this.targetMs;
    this.targetMs = rounded;
    const reason =
      rounded > from
        ? `jitter p95 ${this.jitterP95Ms()}ms raised target ${from}ms -> ${rounded}ms`
        : `jitter p95 ${this.jitterP95Ms()}ms lowered target ${from}ms -> ${rounded}ms`;
    this.adaptations.push({ atMs, fromMs: from, toMs: rounded, jitterMs: this.jitterP95Ms(), reason });
  }
}

/** Playout schedule for one frame: when it should be heard. */
export interface VoiceV23PlayoutSlot {
  seq: number;
  playAtMs: number;
  lateMs: number;
}

/**
 * Frame pacer: turns buffer pulls into a steady playout
 * schedule at the nominal frame rate, and reports drift
 * (how far playout slipped behind the schedule).
 */
export class FramePacerV23 {
  private nextPlayAtMs: number | null = null;
  private scheduled = 0;
  private late = 0;
  private driftMsTotal = 0;

  /** Schedule the next frame. First call anchors the schedule. */
  schedule(seq: number, atMs: number): VoiceV23PlayoutSlot {
    if (this.nextPlayAtMs === null) this.nextPlayAtMs = atMs;
    const playAtMs = this.nextPlayAtMs;
    this.nextPlayAtMs += VOICE_V23_FRAME_MS;
    this.scheduled += 1;
    const lateMs = Math.max(0, atMs - playAtMs);
    if (lateMs > 0) {
      this.late += 1;
      this.driftMsTotal += lateMs;
    }
    return { seq, playAtMs, lateMs };
  }

  /** Re-anchor the schedule after a gap (e.g. after an underrun). */
  resync(atMs: number): void {
    this.nextPlayAtMs = atMs;
  }

  stats(): { scheduled: number; late: number; meanDriftMs: number; nextPlayAtMs: number | null } {
    return {
      scheduled: this.scheduled,
      late: this.late,
      meanDriftMs: this.scheduled === 0 ? 0 : round2V23(this.driftMsTotal / this.scheduled),
      nextPlayAtMs: this.nextPlayAtMs,
    };
  }

  reset(): void {
    this.nextPlayAtMs = null;
    this.scheduled = 0;
    this.late = 0;
    this.driftMsTotal = 0;
  }
}

/** Recommend a buffer target from raw network observations. */
export function recommendBufferTargetV23(
  jitterP95Ms: number,
  lossPct: number,
  opts: Partial<AdaptiveBufferV23Options> = {},
): { targetMs: number; reason: string } {
  const o = { ...defaultAdaptiveBufferV23Options(), ...opts };
  const fromJitter = o.baseTargetMs + o.jitterGain * Math.max(0, jitterP95Ms);
  const fromLoss = o.baseTargetMs + Math.max(0, lossPct) * 8;
  const targetMs = Math.round(clampV23(Math.max(fromJitter, fromLoss), o.minTargetMs, o.maxTargetMs));
  const reason = `jitter p95 ${jitterP95Ms}ms + loss ${lossPct}% -> target ${targetMs}ms`;
  return { targetMs, reason };
}

/** Mean inter-arrival jitter of a frame arrival trace (ms). */
export function traceJitterV23(arrivalMs: readonly number[]): number {
  if (arrivalMs.length < 2) return 0;
  const deviations: number[] = [];
  for (let i = 1; i < arrivalMs.length; i += 1) {
    deviations.push(Math.abs(arrivalMs[i] - arrivalMs[i - 1] - VOICE_V23_FRAME_MS));
  }
  return round2V23(meanV23(deviations));
}
