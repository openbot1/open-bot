/**
 * Barge-in v4 (v1.17, Đội T5 — voice v16).
 *
 * v15 decided *whether* a burst is really the user (energy gate,
 * cough / breath / noise / echo rejection, debounce, cooldown) and
 * issued a cut receipt for a caller-chosen scope. v16 owns what
 * happens *around* the cut, because cutting is only half the job —
 * the other half is not losing the conversation:
 *
 *   1. Stop TTS immediately. The cut is issued the moment the
 *      detector confirms speech (`cutDelayMs` is 0 by default and
 *      configurable for hosts that want one last confirmation
 *      frame); the TTS stream is stopped through the injected
 *      `stopTts` callback, not by queueing.
 *   2. Keep the spoken prefix + context. The receipt records
 *      exactly what the agent had already said (`spokenText`,
 *      `spokenChars`), what it had not (`remainingText`), and a
 *      turn-context snapshot (`turnId`, user text, reply text, the
 *      cut point) so the session can resume, re-speak from the cut
 *      point, or summarise what was cut — instead of pretending
 *      the interrupted sentence never happened. A cut that keeps
 *      fewer than `minSpokenCharsToKeep` spoken chars is reported
 *      as a *full* cut (nothing worth keeping); above it, a
 *      *partial* cut.
 *   3. Echo-aware while TTS is playing. While the agent speaks,
 *      its own audio leaks back through the mic. Frames flagged
 *      `echo: true` are rejected as before, but v16 also tracks an
 *      *expected echo level* (the RMS the TTS is currently playing
 *      at, reported by the session via `setTtsLevel()`): a frame
 *      only counts as user speech when it exceeds the echo level
 *      by `echoMarginRatio`. A loud user can still cut through a
 *      loud bot; a quiet echo cannot cut at all.
 *   4. Capture the interruption. After a cut, the frames that
 *      follow belong to the user's new turn, not to the old one:
 *      the engine buffers them as an interrupting utterance
 *      (`interruptingText`, fed by the session from STT partials)
 *      and hands it back with the receipt, so the next turn starts
 *      with the user's words already in hand.
 *
 * Thresholds are all configurable (`BargeInV16Options` extends
 * the v15 options); the v15 detector still owns the burst
 * classification underneath. Virtual clock, no mic, no sound card.
 */

import { BargeInEngineV15, createBargeInEngineV15, frameRmsV15 } from '../voiceV15/bargeInV15';
import type {
  BargeInV15Options,
  BargeInV15CancelScope,
  BargeInV15CutReceipt,
  BargeInV15Frame,
  BargeInV15Event,
  BargeInV15EventSink,
  BargeInV15RejectionReason,
} from '../voiceV15/bargeInV15';

export interface BargeInV16Options extends BargeInV15Options {
  /** Delay (ms) between confirmed speech and the cut (default 0). */
  cutDelayMs?: number;
  /** Keep the spoken prefix in the receipt (default true). */
  keepSpokenPrefix?: boolean;
  /** Spoken chars below this → the cut is reported as full (default 8). */
  minSpokenCharsToKeep?: number;
  /** Frame RMS must exceed echo level × this to count while TTS plays (default 1.6). */
  echoMarginRatio?: number;
  /** ms of interrupting speech to capture after a cut (default 5000). */
  captureWindowMs?: number;
}

export function defaultBargeInV16Options(): Required<BargeInV16Options> {
  return {
    minSpeechMs: 250,
    minSilenceMs: 450,
    coughMaxMs: 120,
    energyRatio: 2.5,
    absoluteEnergyFloor: 0.008,
    breathRatio: 1.4,
    debounceMs: 40,
    cooldownMs: 300,
    noiseFloorAlpha: 0.05,
    cutDelayMs: 0,
    keepSpokenPrefix: true,
    minSpokenCharsToKeep: 8,
    echoMarginRatio: 1.6,
    captureWindowMs: 5000,
  };
}

export function validateBargeInV16Options(options: BargeInV16Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof BargeInV16Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('cutDelayMs', options.cutDelayMs, 0, 2000);
  check('minSpokenCharsToKeep', options.minSpokenCharsToKeep, 0, 1000);
  check('echoMarginRatio', options.echoMarginRatio, 1, 10);
  check('captureWindowMs', options.captureWindowMs, 0, 30000);
  if (options.coughMaxMs !== undefined && options.minSpeechMs !== undefined && options.coughMaxMs >= options.minSpeechMs) {
    errors.push('coughMaxMs must be smaller than minSpeechMs');
  }
  return errors;
}

export type BargeInV16CutKind = 'partial' | 'full';

export interface BargeInV16TurnContext {
  turnId: string;
  userText: string;
  replyText: string;
  /** Agent text already spoken when the cut landed. */
  spokenText: string;
  spokenChars: number;
  /** Agent text never spoken (resume / re-speak from here). */
  remainingText: string;
  remainingChars: number;
}

export interface BargeInV16CutReceipt extends BargeInV15CutReceipt {
  kind: BargeInV16CutKind;
  context: BargeInV16TurnContext;
  /** User speech captured after the cut (the new turn's start). */
  interruptingText: string;
  /** RMS the TTS was playing at when the cut landed (0 when silent). */
  ttsLevelAtCut: number;
}

export type BargeInV16EventKind = BargeInV15EventKind | 'cut-delayed' | 'captured';
export type BargeInV15EventKind = BargeInV15Event['kind'];

export interface BargeInV16Event {
  kind: BargeInV16EventKind;
  atMs: number;
  burstMs?: number;
  reason?: BargeInV15RejectionReason;
  rms?: number;
  receipt?: BargeInV16CutReceipt;
  text?: string;
}

export type BargeInV16EventSink = (event: BargeInV16Event) => void;

export interface BargeInV16Stats {
  speechBursts: number;
  cuts: number;
  partialCuts: number;
  fullCuts: number;
  rejections: Partial<Record<BargeInV15RejectionReason, number>>;
  totalRejections: number;
  echoSuppressions: number;
  lastCutLatencyMs: number | undefined;
  averageCutLatencyMs: number;
  capturedInterruptions: number;
  noiseFloor: number;
}

/** Callbacks the session binds so a cut stops real work. */
export interface BargeInV16Hooks {
  /** Stop the TTS stream now; return what was spoken / remaining. */
  stopTts?: (atMs: number) => { spokenText: string; remainingText: string };
  /** Discard stale LLM work; return tokens discarded. */
  discardLlm?: (atMs: number) => number;
}

/**
 * Detector (v15) + immediate cut + spoken-prefix preservation +
 * echo-aware gating + interruption capture. The session feeds mic
 * frames and, while speaking, the current TTS level; when the
 * detector confirms user speech during agent speech, `interrupt()`
 * runs the hooks and builds the v4 receipt.
 */
export class BargeInEngineV16 {
  readonly engine: BargeInEngineV15;
  private readonly options: Required<BargeInV16Options>;
  private readonly sink: BargeInV16EventSink | undefined;
  private readonly hooks: BargeInV16Hooks;
  private ttsPlaying = false;
  private ttsLevel = 0;
  private agentSpeaking = false;
  private currentTurn: { turnId: string; userText: string; replyText: string } | undefined;
  private readonly cuts: BargeInV16CutReceipt[] = [];
  private readonly echoSuppressions: number[] = [];
  private lastSpeechStartedAtMs: number | undefined;
  private pendingCutAtMs: number | undefined;
  private capturingUntilMs = 0;
  private interruptingText = '';
  private capturedInterruptions = 0;

  constructor(options: BargeInV16Options = {}, hooks: BargeInV16Hooks = {}, sink?: BargeInV16EventSink) {
    const merged = { ...defaultBargeInV16Options(), ...options };
    const errors = validateBargeInV16Options(merged);
    if (errors.length > 0) throw new Error(`invalid barge-in v16 options: ${errors.join('; ')}`);
    this.options = merged;
    this.hooks = hooks;
    this.sink = sink;
    this.engine = createBargeInEngineV15(merged, (event) => {
      if (event.kind === 'speech-started') {
        this.lastSpeechStartedAtMs = event.atMs;
        if (this.agentSpeaking) {
          if (this.options.cutDelayMs > 0) {
            this.pendingCutAtMs = event.atMs + this.options.cutDelayMs;
            this.sink?.({ kind: 'cut-delayed', atMs: event.atMs, burstMs: event.burstMs, rms: event.rms });
            return;
          }
          void this.interrupt(event.atMs);
        }
      }
      this.sink?.(event);
    });
  }

  /** The agent started speaking this turn (context for the receipt). */
  beginAgentTurn(turnId: string, userText: string, replyText: string, atMs: number): void {
    this.currentTurn = { turnId, userText, replyText };
    this.agentSpeaking = true;
    this.ttsPlaying = true;
    void atMs;
  }

  /** The agent finished speaking normally (no cut). */
  endAgentTurn(): void {
    this.agentSpeaking = false;
    this.ttsPlaying = false;
    this.ttsLevel = 0;
    this.currentTurn = undefined;
  }

  /** Current TTS playback RMS (the expected echo level). */
  setTtsLevel(rms: number): void {
    this.ttsLevel = Math.max(0, rms);
  }

  setAgentSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
    this.ttsPlaying = speaking;
    if (!speaking) this.ttsLevel = 0;
  }

  isAgentSpeaking(): boolean {
    return this.agentSpeaking;
  }

  isCapturing(): boolean {
    return this.capturingUntilMs > 0;
  }

  /** Feed one 20 ms mic frame. Returns the event fired, if any. */
  feed(frame: BargeInV15Frame): BargeInV16Event | undefined {
    // Echo-aware gate while the bot speaks: a frame barely above the
    // echo the TTS itself produces cannot be the user cutting in.
    if (this.ttsPlaying && this.ttsLevel > 0 && frame.echo !== true) {
      const rms = frameRmsV15(frame.frame);
      if (rms < this.ttsLevel * this.options.echoMarginRatio) {
        this.echoSuppressions.push(frame.atMs);
        const event: BargeInV16Event = { kind: 'rejected', atMs: frame.atMs, reason: 'echo', rms };
        this.sink?.(event);
        return event;
      }
    }
    const event = this.engine.feed(frame);
    if (!event) return undefined;
    return event as BargeInV16Event;
  }

  /** Feed STT partial text for the interrupting utterance (after a cut). */
  feedInterruptingText(text: string, atMs: number): void {
    if (this.capturingUntilMs === 0 || atMs > this.capturingUntilMs) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.interruptingText = trimmed;
    this.sink?.({ kind: 'captured', atMs, text: trimmed });
  }

  /** Advance the clock; fires a delayed cut when its time comes. */
  tick(atMs: number): BargeInV16CutReceipt | undefined {
    if (this.pendingCutAtMs !== undefined && atMs >= this.pendingCutAtMs) {
      const startedAt = this.lastSpeechStartedAtMs ?? atMs;
      this.pendingCutAtMs = undefined;
      return this.interrupt(atMs, startedAt);
    }
    if (this.capturingUntilMs !== 0 && atMs > this.capturingUntilMs) {
      this.capturingUntilMs = 0;
      if (this.interruptingText) this.capturedInterruptions += 1;
    }
    return undefined;
  }

  /**
   * Cut now: stop TTS through the hook, discard stale LLM work,
   * keep the spoken prefix + turn context in the receipt.
   */
  interrupt(atMs: number, speechStartedAtMs?: number): BargeInV16CutReceipt | undefined {
    if (!this.agentSpeaking && !this.currentTurn) return undefined;
    const startedAt = speechStartedAtMs ?? this.lastSpeechStartedAtMs ?? atMs;
    const stopped = this.hooks.stopTts?.(atMs) ?? { spokenText: '', remainingText: this.currentTurn?.replyText ?? '' };
    const discardedLlm = this.hooks.discardLlm?.(atMs) ?? 0;
    const spokenText = this.options.keepSpokenPrefix ? stopped.spokenText : '';
    const context: BargeInV16TurnContext = {
      turnId: this.currentTurn?.turnId ?? '',
      userText: this.currentTurn?.userText ?? '',
      replyText: this.currentTurn?.replyText ?? '',
      spokenText,
      spokenChars: spokenText.length,
      remainingText: stopped.remainingText,
      remainingChars: stopped.remainingText.length,
    };
    this.engine.setDiscardCounts({
      ttsChunks: stopped.remainingText ? stopped.remainingText.split(/\s+/).length : 0,
      llmTokens: discardedLlm,
      sttPartials: 0,
    });
    const base = this.engine.interrupt(startedAt, atMs, { tts: true, llm: true, stt: true });
    const receipt: BargeInV16CutReceipt = {
      ...base,
      kind: spokenText.length >= this.options.minSpokenCharsToKeep ? 'partial' : 'full',
      context,
      interruptingText: this.interruptingText,
      ttsLevelAtCut: this.ttsLevel,
    };
    this.cuts.push(receipt);
    this.agentSpeaking = false;
    this.ttsPlaying = false;
    this.ttsLevel = 0;
    this.currentTurn = undefined;
    this.interruptingText = '';
    this.capturingUntilMs = atMs + this.options.captureWindowMs;
    this.sink?.({ kind: 'cut', atMs, burstMs: base.cutLatencyMs, receipt });
    return receipt;
  }

  lastCut(): BargeInV16CutReceipt | undefined {
    return this.cuts[this.cuts.length - 1];
  }

  cutsList(): BargeInV16CutReceipt[] {
    return [...this.cuts];
  }

  stats(): BargeInV16Stats {
    const base = this.engine.stats();
    const latencies = this.cuts.map((c) => c.cutLatencyMs);
    return {
      speechBursts: base.speechBursts,
      cuts: this.cuts.length,
      partialCuts: this.cuts.filter((c) => c.kind === 'partial').length,
      fullCuts: this.cuts.filter((c) => c.kind === 'full').length,
      rejections: base.rejections,
      totalRejections: base.totalRejections,
      echoSuppressions: this.echoSuppressions.length,
      lastCutLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1] : undefined,
      averageCutLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      capturedInterruptions: this.capturedInterruptions,
      noiseFloor: base.noiseFloor,
    };
  }

  summary(): string {
    const s = this.stats();
    return `barge-in v16: ${s.speechBursts} bursts, ${s.cuts} cuts (${s.partialCuts} partial, ${s.fullCuts} full), ` +
      `avg cut ${s.averageCutLatencyMs} ms, ${s.echoSuppressions} echo suppressions, ` +
      `${s.capturedInterruptions} interruptions captured, ${s.totalRejections} rejected`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Barge-in v16',
      '',
      `- Speech bursts: ${s.speechBursts}; cuts: ${s.cuts} (${s.partialCuts} partial, ${s.fullCuts} full)`,
      `- Average cut latency: ${s.averageCutLatencyMs} ms${s.lastCutLatencyMs !== undefined ? ` (last ${s.lastCutLatencyMs} ms)` : ''}`,
      `- Echo suppressions while TTS playing: ${s.echoSuppressions}`,
      `- Interruptions captured: ${s.capturedInterruptions}; rejected bursts: ${s.totalRejections}`,
      `- Noise floor (RMS): ${s.noiseFloor.toFixed(4)}`,
      '',
      '| Reason | Count |',
      '| --- | ---: |',
    ];
    const reasons: BargeInV15RejectionReason[] = ['cough', 'breath', 'noise', 'echo', 'cooldown'];
    for (const reason of reasons) {
      lines.push(`| ${reason} | ${s.rejections[reason] ?? 0} |`);
    }
    lines.push('');
    for (const cut of this.cuts) {
      lines.push(`- Cut @${cut.atMs} ms (${cut.kind}): latency ${cut.cutLatencyMs} ms, spoke “${cut.context.spokenText}” ` +
        `(${cut.context.spokenChars} chars), remaining “${cut.context.remainingText}”` +
        `${cut.interruptingText ? `, user cut in with “${cut.interruptingText}”` : ''}.`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

export function createBargeInEngineV16(
  options: BargeInV16Options = {},
  hooks: BargeInV16Hooks = {},
  sink?: BargeInV16EventSink,
): BargeInEngineV16 {
  return new BargeInEngineV16(options, hooks, sink);
}

export function bargeInV16Summary(engine: BargeInEngineV16): string {
  return engine.summary();
}

export function bargeInV16Markdown(engine: BargeInEngineV16): string {
  return engine.markdown();
}
