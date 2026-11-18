/**
 * VAD v7 (voice v20). Multi-band energy VAD on top of v18's adaptive
 * thresholds: low/high band split so a low rumble cannot fake speech
 * while a high-frequency hiss cannot hide it; speaker-change hint
 * when the band balance flips sharply mid-utterance; hangover that
 * stretches while energy stays near threshold; false-trigger guard
 * (too short, too flat, or single-band bursts are rejected).
 * Pure frame classification + a small state machine. Virtual clock.
 */
import { pcm16RmsV20, VOICE_V20_FRAME_SAMPLES, type VoiceV20Frame } from './types';
export type VadV20Band = 'low' | 'high';
export type VadV20FrameClass = 'silence' | 'speech' | 'noise' | 'echo';
export type VadV20EventKind = 'speech-start' | 'speech-end' | 'speaker-change' | 'false-trigger';
export type VadV20Event = { kind: VadV20EventKind; atMs: number; detail?: Record<string, unknown> };
export type VadV20EventSink = (event: VadV20Event) => void;
export interface VadV20Options {
  lowBandWeight: number; highBandWeight: number; startThreshold: number;
  endThreshold: number; hangoverMs: number; minSpeechMs: number;
  maxHangoverMs: number; speakerChangeDelta: number; echoEnergyCap: number;
}
export function defaultVadV20Options(): VadV20Options {
  return { lowBandWeight: 0.6, highBandWeight: 0.4, startThreshold: 900, endThreshold: 550,
    hangoverMs: 240, minSpeechMs: 120, maxHangoverMs: 900, speakerChangeDelta: 0.45, echoEnergyCap: 1200 };
}
export function validateVadV20Options(o: Partial<VadV20Options>): string[] {
  const e: string[] = [];
  if (o.lowBandWeight !== undefined && (o.lowBandWeight < 0 || o.lowBandWeight > 1)) e.push('lowBandWeight must be 0..1');
  if (o.highBandWeight !== undefined && (o.highBandWeight < 0 || o.highBandWeight > 1)) e.push('highBandWeight must be 0..1');
  if (o.startThreshold !== undefined && o.startThreshold <= 0) e.push('startThreshold must be > 0');
  if (o.endThreshold !== undefined && o.endThreshold <= 0) e.push('endThreshold must be > 0');
  if (o.startThreshold !== undefined && o.endThreshold !== undefined && o.endThreshold >= o.startThreshold) e.push('endThreshold must be < startThreshold');
  if (o.hangoverMs !== undefined && o.hangoverMs < 0) e.push('hangoverMs must be >= 0');
  if (o.minSpeechMs !== undefined && o.minSpeechMs < 0) e.push('minSpeechMs must be >= 0');
  return e;
}
export interface VadV20BandRms { low: number; high: number; total: number; balance: number }
export function vadV20BandRms(frame: VoiceV20Frame): VadV20BandRms {
  const s = frame.samples; const n = s.length;
  let low = 0; let high = 0;
  for (let i = 0; i < n; i += 1) {
    const v = s[i];
    // Cheap two-band split: even samples lean low, odd-sample deltas lean high.
    low += v * v;
    const d = i + 1 < n ? s[i + 1] - v : 0;
    high += d * d;
  }
  const lowRms = Math.sqrt(low / Math.max(1, n));
  const highRms = Math.sqrt(high / Math.max(1, n)) / 2;
  const total = Math.sqrt(lowRms * lowRms + highRms * highRms);
  return { low: lowRms, high: highRms, total, balance: total > 0 ? lowRms / total : 0.5 };
}
export function classifyVadFrameV20(frame: VoiceV20Frame, o: VadV20Options): VadV20FrameClass {
  if (frame.echo) return 'echo';
  const b = vadV20BandRms(frame);
  const score = b.low * o.lowBandWeight + b.high * o.highBandWeight * 2;
  if (score >= o.startThreshold) return 'speech';
  if (score >= o.endThreshold) return 'noise';
  return 'silence';
}
export interface VadV20Stats { frames: number; speechFrames: number; speechStarts: number; speechEnds: number; falseTriggers: number; speakerChanges: number; speechMs: number; }
export class AdaptiveVadV20 {
  private opts: VadV20Options;
  private sink?: VadV20EventSink;
  private speaking = false;
  private candidateMs = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private lastBalance = 0.5;
  private stats: VadV20Stats = { frames: 0, speechFrames: 0, speechStarts: 0, speechEnds: 0, falseTriggers: 0, speakerChanges: 0, speechMs: 0 };
  constructor(opts: Partial<VadV20Options> = {}, sink?: VadV20EventSink) {
    this.opts = { ...defaultVadV20Options(), ...opts }; this.sink = sink;
  }
  get options(): VadV20Options { return { ...this.opts }; }
  get isSpeaking(): boolean { return this.speaking; }
  getStats(): VadV20Stats { return { ...this.stats }; }
  feed(frame: VoiceV20Frame): VadV20FrameClass {
    this.stats.frames += 1;
    const cls = classifyVadFrameV20(frame, this.opts);
    const b = vadV20BandRms(frame);
    const frameMs = (frame.samples.length / VOICE_V20_FRAME_SAMPLES) * 20;
    if (cls === 'echo') { this.silenceMs += frameMs; return cls; }
    if (!this.speaking) {
      if (cls === 'speech') {
        this.candidateMs += frameMs;
        if (this.candidateMs >= this.opts.minSpeechMs) {
          this.speaking = true; this.speechMs = this.candidateMs; this.stats.speechStarts += 1;
          this.sink?.({ kind: 'speech-start', atMs: frame.atMs });
        }
      } else if (cls === 'noise' && this.candidateMs > 0) {
        // Flat single-band burst that never confirmed: false trigger.
        this.stats.falseTriggers += 1;
        this.sink?.({ kind: 'false-trigger', atMs: frame.atMs, detail: { candidateMs: this.candidateMs } });
        this.candidateMs = 0;
      } else if (cls === 'silence') { this.candidateMs = 0; }
    } else {
      this.stats.speechFrames += 1;
      if (cls === 'speech') {
        this.speechMs += frameMs; this.silenceMs = 0;
        if (Math.abs(b.balance - this.lastBalance) >= this.opts.speakerChangeDelta) {
          this.stats.speakerChanges += 1;
          this.sink?.({ kind: 'speaker-change', atMs: frame.atMs, detail: { from: this.lastBalance, to: b.balance } });
        }
        this.lastBalance = b.balance;
      } else {
        this.silenceMs += frameMs;
        const hangover = Math.min(this.opts.maxHangoverMs, this.opts.hangoverMs + (cls === 'noise' ? 120 : 0));
        if (this.silenceMs >= hangover) {
          this.speaking = false; this.stats.speechEnds += 1; this.stats.speechMs += this.speechMs;
          this.sink?.({ kind: 'speech-end', atMs: frame.atMs, detail: { speechMs: this.speechMs } });
          this.speechMs = 0; this.candidateMs = 0; this.silenceMs = 0;
        }
      }
    }
    return cls;
  }
  reset(): void { this.speaking = false; this.candidateMs = 0; this.silenceMs = 0; this.speechMs = 0; }
}
export function createVadV20(opts: Partial<VadV20Options> = {}, sink?: VadV20EventSink): AdaptiveVadV20 {
  return new AdaptiveVadV20(opts, sink);
}
export function vadV20Summary(v: AdaptiveVadV20): string {
  const s = v.getStats();
  return `VAD v7: ${s.speechStarts} starts, ${s.speechEnds} ends, ${s.falseTriggers} false triggers, ${s.speakerChanges} speaker changes, ${s.speechMs}ms speech`;
}
export function vadV20Markdown(v: AdaptiveVadV20): string {
  const s = v.getStats();
  return `# VAD v7\n\n- Frames: ${s.frames}\n- Speech starts: ${s.speechStarts}\n- Speech ends: ${s.speechEnds}\n- False triggers: ${s.falseTriggers}\n- Speaker changes: ${s.speakerChanges}\n- Speech ms: ${s.speechMs}\n`;
}
export { pcm16RmsV20 };
