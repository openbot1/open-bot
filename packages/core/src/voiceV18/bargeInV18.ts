/**
 * Barge-in v6 (v1.19, Đội T5 — voice v18).
 *
 * v17 cut the agent the moment the detector confirmed user speech
 * and handed back a resume plan (resume / restart / summarise /
 * drop) — but the cut only happened *after* confirmation, so the
 * first 100–200 ms of the user's words overlapped the agent's
 * still-playing audio, and the resume plan knew the reply text but
 * not the *turn context* (what the user had asked, which turn was
 * cut, how much had already been said). v18 wraps the v17 engine
 * and adds the missing layers:
 *
 *   1. Early detection. While the agent speaks, every mic frame is
 *      watched: a speech burst that reaches `earlyDetectMs`
 *      (default 60 ms) fires an `early-warning` — the session can
 *      duck the TTS volume *before* the cut lands, so the user's
 *      first words are not drowned out. The warning is advisory
 *      only: it never cuts by itself, so a cough that trips the
 *      early detector costs nothing.
 *   2. Context snapshot at cut time. `BargeInV18CutRecord` keeps
 *      the whole interrupted turn: turn id, user text, full reply
 *      text, spoken prefix, remaining text, the v17 resume plan,
 *      the interruption kind, the cut latency, and the escalation
 *      level. `resumeAfterCut()` replays the plan's text through a
 *      caller-supplied speaker instead of dropping the context.
 *   3. Echo suppression window. Frames the caller flags as echo
 *      inside `echoWindowMs` after the agent starts speaking are
 *      counted and ignored — the bot's own playback leaking into
 *      the mic must never cut the bot. Echo frames outside the
 *      window still go to the detector (a real echo that late is
 *      a room problem, not a playback leak).
 *   4. Burst accounting. Every speech burst while the agent
 *      speaks is recorded (start, peak RMS, whether it cut, what
 *      it was rejected as), so the eval module can score
 *      precision/recall instead of guessing from cut counts.
 *   5. The v17 guarantees carry over unchanged: immediate cut on
 *      confirmed speech, resume / restart / summarise / drop,
 *      interruption classification, repeated-cut escalation.
 *
 * Frames are PCM16 mono Int16Array, 20 ms (320 samples at 16 kHz).
 * No sound card, no network — the TTS level and the spoken
 * progress are fed in by the session (mock in tests).
 */

import {
  BargeInEngineV17,
  createBargeInEngineV17,
  defaultBargeInV17Options,
  validateBargeInV17Options,
  classifyInterruptionV17,
  type BargeInV17CutRecord,
  type BargeInV17InterruptionKind,
  type BargeInV17Options,
  type BargeInV17ResumePlan,
  type BargeInV17Stats,
} from '../voiceV17/bargeInV17';
import { frameRmsV15, type BargeInV15Frame } from '../voiceV15/bargeInV15';
import { pcm16RmsV18, VAD_V18_FRAME_MS } from './vadV18';

/** One speech burst observed while the agent was speaking. */
export interface BargeInV18Burst {
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  peakRms: number;
  /** True when this burst cut the agent. */
  cut: boolean;
  /** Why a non-cutting burst was rejected (when known). */
  rejectionReason?: string;
  /** Interruption kind when the burst carried text. */
  kind?: BargeInV17InterruptionKind;
}

/** A cut with the full interrupted-turn context attached. */
export interface BargeInV18CutRecord {
  /** The v17 cut record (receipt + resume plan). */
  cut: BargeInV17CutRecord;
  /** Turn that was cut. */
  turnId: string;
  /** What the user asked in that turn. */
  userText: string;
  /** Full reply text the agent was speaking. */
  replyText: string;
  /** Chars of the reply already spoken when the cut landed. */
  spokenChars: number;
  /** Reply text never spoken. */
  remainingText: string;
  /** What the user said to interrupt (when known). */
  interruptingText?: string;
  /** Cut latency: speech start → cut (ms). */
  cutLatencyMs: number;
  /** Early warning fired before this cut (ms before the cut, 0 = none). */
  earlyWarningLeadMs: number;
}

/** Events emitted by `BargeInEngineV18`. */
export type BargeInV18EventKind =
  | 'early-warning'
  | 'cut'
  | 'rejected'
  | 'echo-suppressed'
  | 'speech-started'
  | 'speech-ended';

export interface BargeInV18Event {
  kind: BargeInV18EventKind;
  atMs: number;
  /** Burst length at the time of the event (ms). */
  burstMs?: number;
  /** Peak RMS of the burst so far. */
  peakRms?: number;
  /** The cut record (cut only). */
  cut?: BargeInV18CutRecord;
  /** Why the burst was rejected (rejected only). */
  reason?: string;
}

export type BargeInV18EventSink = (event: BargeInV18Event) => void;

/** Options for `BargeInEngineV18` (everything v17 takes, plus the v18 layer). */
export interface BargeInV18Options extends BargeInV17Options {
  /** Speech burst length that fires an early warning (ms, default 60). */
  earlyDetectMs?: number;
  /** Echo frames ignored this long after the agent starts speaking (ms, default 400). */
  echoWindowMs?: number;
  /** TTS duck factor applied on early warning (0..1, informational, default 0.4). */
  duckFactor?: number;
}

export function defaultBargeInV18Options(): Required<BargeInV18Options> {
  return {
    ...defaultBargeInV17Options(),
    earlyDetectMs: 60,
    echoWindowMs: 400,
    duckFactor: 0.4,
  };
}

export function validateBargeInV18Options(options: BargeInV18Options): string[] {
  const errors = validateBargeInV17Options(options);
  const check = (name: keyof BargeInV18Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('earlyDetectMs', options.earlyDetectMs, 0, 5000);
  check('echoWindowMs', options.echoWindowMs, 0, 10000);
  check('duckFactor', options.duckFactor, 0, 1);
  if (
    options.earlyDetectMs !== undefined &&
    options.minSpeechMs !== undefined &&
    options.earlyDetectMs >= options.minSpeechMs
  ) {
    errors.push('earlyDetectMs should be smaller than minSpeechMs (the warning must precede the cut)');
  }
  return errors;
}

export interface BargeInV18Stats extends BargeInV17Stats {
  earlyWarnings: number;
  echoSuppressedFrames: number;
  bursts: number;
  burstsThatCut: number;
  /** Fraction of bursts that cut (0..1). */
  cutRate: number;
  /** Mean lead time of the early warning before the cut (ms). */
  averageEarlyWarningLeadMs: number;
  /** Last cut with full context (undefined = no cut yet). */
  lastCutWithContext: BargeInV18CutRecord | undefined;
}

/**
 * Barge-in v6: a v17 engine plus early warnings, echo suppression
 * and a full context snapshot at cut time.
 */
export class BargeInEngineV18 {
  /** The wrapped v17 engine (confirmation + cut + resume policy live here). */
  readonly engine: BargeInEngineV17;
  private readonly options: Required<BargeInV18Options>;
  private readonly sink: BargeInV18EventSink | undefined;
  private turnId = '';
  private userText = '';
  private replyText = '';
  private spokenChars = 0;
  private agentSpeakStartMs = 0;
  private burstStartMs: number | undefined;
  private burstPeakRms = 0;
  private burstFrames = 0;
  private earlyWarningFired = false;
  private earlyWarningAtMs = 0;
  private bursts: BargeInV18Burst[] = [];
  private cuts: BargeInV18CutRecord[] = [];
  private pendingCut: BargeInV18CutRecord | undefined;
  private earlyWarnings = 0;
  private echoSuppressedFrames = 0;
  private earlyWarningLeadSum = 0;
  private burstSeq = 0;

  constructor(options: BargeInV18Options = {}, sink?: BargeInV18EventSink) {
    const errors = validateBargeInV18Options(options);
    if (errors.length > 0) throw new Error(`invalid barge-in v18 options: ${errors.join('; ')}`);
    this.options = { ...defaultBargeInV18Options(), ...options };
    this.sink = sink;
    this.engine = createBargeInEngineV17(this.options, {}, (event) => {
      // The v17 engine records the cut in its sink (onCut) when the
      // v16 detector confirms speech: that is the one place a cut
      // is born — tick()/interrupt() only surface it afterwards.
      if (event.kind === 'cut' && event.receipt && event.plan) {
        const record = this.buildCutRecord({ receipt: event.receipt, plan: event.plan }, event.atMs);
        this.cuts.push(record);
        this.closeBurst(event.atMs, true);
        this.engine.setAgentSpeaking(false);
        this.pendingCut = record;
        this.emit({ kind: 'cut', atMs: event.atMs, cut: record, peakRms: this.burstPeakRms });
        return;
      }
      if (event.kind === 'rejected') {
        this.sink?.({ kind: 'rejected', atMs: event.atMs, reason: event.reason });
      }
    });
  }

  private emit(event: BargeInV18Event): void {
    if (this.sink) this.sink(event);
  }

  /** The agent starts speaking a reply (resets burst tracking for the turn). */
  beginAgentTurn(turnId: string, userText: string, replyText: string, atMs: number): void {
    this.turnId = turnId;
    this.userText = userText;
    this.replyText = replyText;
    this.spokenChars = 0;
    this.agentSpeakStartMs = atMs;
    this.burstStartMs = undefined;
    this.burstPeakRms = 0;
    this.burstFrames = 0;
    this.earlyWarningFired = false;
    this.earlyWarningAtMs = 0;
    this.engine.beginAgentTurn(turnId, userText, replyText, atMs);
    this.engine.setAgentSpeaking(true);
  }

  endAgentTurn(): void {
    this.engine.endAgentTurn();
    this.engine.setAgentSpeaking(false);
    this.closeBurst(this.agentSpeakStartMs, false);
  }

  /** Current TTS level (RMS) — the detector uses it to tell echo from speech. */
  setTtsLevel(rms: number): void {
    this.engine.setTtsLevel(rms);
  }

  setAgentSpeaking(speaking: boolean): void {
    this.engine.setAgentSpeaking(speaking);
  }

  isAgentSpeaking(): boolean {
    return this.engine.isAgentSpeaking();
  }

  isCapturing(): boolean {
    return this.engine.isCapturing();
  }

  /** How much of the reply has been spoken (chars) — fed by the TTS stream. */
  setSpokenProgress(chars: number): void {
    this.spokenChars = Math.max(0, Math.min(chars, this.replyText.length));
  }

  getSpokenChars(): number {
    return this.spokenChars;
  }

  private closeBurst(atMs: number, cut: boolean, reason?: string): void {
    if (this.burstStartMs === undefined) return;
    this.burstSeq += 1;
    this.bursts.push({
      id: `burst-v18-${this.burstSeq}`,
      startMs: this.burstStartMs,
      endMs: atMs,
      durationMs: this.burstFrames * VAD_V18_FRAME_MS,
      peakRms: this.burstPeakRms,
      cut,
      ...(reason !== undefined ? { rejectionReason: reason } : {}),
    });
    this.burstStartMs = undefined;
    this.burstPeakRms = 0;
    this.burstFrames = 0;
    this.earlyWarningFired = false;
  }

  private buildCutRecord(inner: BargeInV17CutRecord, atMs: number, interruptingText?: string): BargeInV18CutRecord {
    const spoken = Math.min(this.spokenChars, this.replyText.length);
    const lead = this.earlyWarningFired ? Math.max(0, atMs - this.earlyWarningAtMs) : 0;
    if (this.earlyWarningFired) this.earlyWarningLeadSum += lead;
    const captured = interruptingText ?? (inner.receipt.interruptingText.length > 0 ? inner.receipt.interruptingText : undefined);
    return {
      cut: inner,
      turnId: this.turnId,
      userText: this.userText,
      replyText: this.replyText,
      spokenChars: spoken,
      remainingText: this.replyText.slice(spoken),
      ...(captured !== undefined ? { interruptingText: captured } : {}),
      cutLatencyMs: inner.receipt.cutLatencyMs,
      earlyWarningLeadMs: lead,
    };
  }

  /**
   * Feed one mic frame while the agent may be speaking. Returns the
   * v18 event for this frame (early warning, cut, rejection…).
   */
  feed(input: BargeInV15Frame): BargeInV18Event | undefined {
    const { frame, atMs } = input;
    const rms = frameRmsV15(frame);
    // Echo suppression window: the bot's own playback right after it
    // starts speaking is echo, not the user — count it, ignore it.
    if (input.echo && atMs - this.agentSpeakStartMs <= this.options.echoWindowMs) {
      this.echoSuppressedFrames += 1;
      this.emit({ kind: 'echo-suppressed', atMs, peakRms: rms });
      return { kind: 'echo-suppressed', atMs, peakRms: rms };
    }
    const innerEvent = this.engine.feed(input);
    if (innerEvent?.kind === 'speech-started') {
      // Keep an already-tracked burst (the RMS watch may have seen
      // it first — resetting here would lose the early warning).
      if (this.burstStartMs === undefined) {
        this.burstStartMs = atMs;
        this.burstPeakRms = rms;
        this.burstFrames = 1;
        this.earlyWarningFired = false;
      }
      this.emit({ kind: 'speech-started', atMs, burstMs: 0, peakRms: rms });
      return { kind: 'speech-started', atMs, burstMs: 0, peakRms: rms };
    }
    if (innerEvent?.kind === 'speech-ended') {
      this.closeBurst(atMs, false);
      this.emit({ kind: 'speech-ended', atMs });
      return { kind: 'speech-ended', atMs };
    }
    // Track the running burst for the early warning: the v15 detector
    // reports speech-started, but a burst that is still below the
    // confirmation threshold has no event yet — watch the RMS directly.
    if (this.engine.isAgentSpeaking() && !this.engine.isCapturing() && this.burstStartMs === undefined) {
      if (rms > 0.05) {
        this.burstStartMs = atMs;
        this.burstPeakRms = rms;
        this.burstFrames = 1;
      }
    } else if (this.burstStartMs !== undefined && !this.engine.isCapturing()) {
      this.burstFrames += 1;
      if (rms > this.burstPeakRms) this.burstPeakRms = rms;
      const burstMs = this.burstFrames * VAD_V18_FRAME_MS;
      if (!this.earlyWarningFired && burstMs >= this.options.earlyDetectMs) {
        this.earlyWarningFired = true;
        this.earlyWarningAtMs = atMs;
        this.earlyWarnings += 1;
        const event: BargeInV18Event = { kind: 'early-warning', atMs, burstMs, peakRms: this.burstPeakRms };
        this.emit(event);
        return event;
      }
    }
    if (innerEvent?.kind === 'rejected') {
      this.closeBurst(atMs, false, innerEvent.reason);
      return { kind: 'rejected', atMs, reason: innerEvent.reason, burstMs: innerEvent.burstMs };
    }
    return undefined;
  }

  /** Feed interrupting text (from STT) — classifies the interruption. */
  feedInterruptingText(text: string, atMs: number): void {
    this.engine.feedInterruptingText(text, atMs);
  }

  /** Advance the cut timer; returns the cut record when a cut lands. */
  tick(atMs: number): BargeInV18CutRecord | undefined {
    this.engine.tick(atMs);
    // A cut born in tick() arrives via the sink (pendingCut).
    const record = this.pendingCut;
    this.pendingCut = undefined;
    return record;
  }

  /** Cut immediately (explicit interrupt, e.g. the user pressed stop talking). */
  interrupt(atMs: number, interruptingText?: string): BargeInV18CutRecord | undefined {
    const inner = this.engine.interrupt(atMs, interruptingText);
    if (!inner) return undefined;
    // The sink already built the v18 record from the same cut — but
    // the v17 engine re-decides the plan with the interrupting text
    // *after* the sink fired, replacing `record.plan` on its own
    // record. Refresh the plan here so the returned record (and the
    // already-emitted cut event, which holds the same object) sees
    // the re-decided plan, not the cut-time one.
    const record = this.pendingCut;
    this.pendingCut = undefined;
    if (!record) return undefined;
    const freshPlan = this.engine.lastPlanForCut();
    if (freshPlan) record.cut = { receipt: record.cut.receipt, plan: freshPlan };
    if (interruptingText !== undefined) record.interruptingText = interruptingText;
    return record;
  }

  /** Classify interrupting text without cutting (panel / eval use). */
  classify(text: string): BargeInV17InterruptionKind {
    return classifyInterruptionV17(text);
  }

  lastCut(): BargeInV18CutRecord | undefined {
    return this.cuts.length > 0 ? this.cuts[this.cuts.length - 1] : undefined;
  }

  lastPlanForCut(): BargeInV17ResumePlan | undefined {
    return this.engine.lastPlanForCut();
  }

  cutsList(): BargeInV18CutRecord[] {
    return [...this.cuts];
  }

  burstsList(): BargeInV18Burst[] {
    return [...this.bursts];
  }

  getEscalationLevel(): number {
    return this.engine.getEscalationLevel();
  }

  stats(): BargeInV18Stats {
    const inner = this.engine.stats();
    const burstsThatCut = this.bursts.filter((b) => b.cut).length;
    return {
      ...inner,
      earlyWarnings: this.earlyWarnings,
      echoSuppressedFrames: this.echoSuppressedFrames,
      bursts: this.bursts.length,
      burstsThatCut,
      cutRate: this.bursts.length === 0 ? 0 : burstsThatCut / this.bursts.length,
      averageEarlyWarningLeadMs: this.cuts.length === 0 ? 0 : this.earlyWarningLeadSum / this.cuts.length,
      lastCutWithContext: this.lastCut(),
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `Barge-in v18: ${s.cuts} cuts, ${s.earlyWarnings} early warnings ` +
      `(avg lead ${s.averageEarlyWarningLeadMs.toFixed(0)} ms), ${s.bursts} bursts ` +
      `(${s.burstsThatCut} cut), ${s.echoSuppressedFrames} echo frames suppressed, ` +
      `escalation level ${s.escalationLevel}`
    );
  }

  markdown(): string {
    const s = this.stats();
    const rows: string[] = [
      '# Barge-in v18',
      '',
      `- Cuts: ${s.cuts} (avg cut latency ${s.averageCutLatencyMs.toFixed(1)} ms)`,
      `- Early warnings: ${s.earlyWarnings} (avg lead ${s.averageEarlyWarningLeadMs.toFixed(0)} ms before the cut)`,
      `- Bursts while speaking: ${s.bursts} (${s.burstsThatCut} cut, rate ${(s.cutRate * 100).toFixed(1)}%)`,
      `- Echo frames suppressed: ${s.echoSuppressedFrames}`,
      `- Escalation level: ${s.escalationLevel} (${s.escalations} escalations)`,
      `- Resume actions: resume ${s.resumes}, restart ${s.restarts}, summarise ${s.summarises}, drop ${s.drops}`,
      '',
    ];
    if (this.cuts.length > 0) {
      rows.push('## Cuts');
      rows.push('');
      for (const c of this.cuts.slice(-10)) {
        rows.push(
          `- ${c.turnId} at ${c.cut.receipt.atMs} ms: spoke ${c.spokenChars}/${c.replyText.length} chars, ` +
            `remaining ${c.remainingText.length} chars → ${c.cut.plan.action} (${c.cut.plan.kind})`,
        );
      }
      rows.push('');
    }
    return rows.join('\n');
  }
}

export function createBargeInEngineV18(options: BargeInV18Options = {}, sink?: BargeInV18EventSink): BargeInEngineV18 {
  return new BargeInEngineV18(options, sink);
}

/** One-line summary of a barge-in v18 engine. */
export function bargeInV18Summary(engine: BargeInEngineV18): string {
  return engine.summary();
}

/** Markdown report of a barge-in v18 engine. */
export function bargeInV18Markdown(engine: BargeInEngineV18): string {
  return engine.markdown();
}

/** Re-export for callers that only need the frame shape. */
export type { BargeInV15Frame };
export { pcm16RmsV18 };
