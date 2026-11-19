/**
 * Barge-in / interruption handling for voice v25 (v1.38, Team T5).
 *
 * Turn-level barge-in handling — what happens *after* the
 * burst-level decision. The decision itself stays in v23
 * (`InterruptionPolicyV23`: grace window, backchannel rule,
 * echo, v22 score); v25 consumes that decision and owns the
 * consequences inside the session:
 *
 *   1. the agent is speaking a planned reply; the user starts
 *      talking; the host reports the burst as a v23 candidate;
 *   2. v23 says `interrupt` — v25 marks the reply "stopping"
 *      and waits for the host to report the agent actually
 *      stopped (`agentStopped`); the gap between burst onset
 *      and the stop is the measured stop latency;
 *   3. the reply is truncated to what was actually spoken
 *      (chars, not guesses — the host reports the TTS offset),
 *      the transcript keeps only the spoken prefix, and the
 *      resume strategy (resume / drop / summarise / rephrase)
 *      comes from v23's `strategyForCutV23`;
 *   4. the interrupting user turn is attached to the record,
 *      so the panel can show "turn 4 cut turn 3 at 1.4s,
 *      62% spoken, resumed from the word start".
 *
 * A `duck` decision never stops the reply: the agent ducks
 * (lowers volume / pauses briefly, host-side) and the event
 * is counted, not recorded as an interruption. An `ignore`
 * decision leaves no record at all.
 *
 * A burst of barge-ins in a short window (default 3 in 30s)
 * raises a `barge-in-burst` alert — usually the user fighting
 * the agent, or a mis-tuned detector — so the operator can see
 * it instead of guessing why turns keep getting cut.
 *
 * All clocks virtual (the caller passes `atMs`); no audio,
 * no network, no key. The host owns the microphone, the TTS
 * engine and the actual stop; v25 only records and decides.
 */
import {
  InterruptionPolicyV23,
  createInterruptionPolicyV23,
  rollbackForCutV23,
  strategyForCutV23,
  type InterruptionV23Options,
  type VoiceV23InterruptionCandidate,
  type VoiceV23InterruptionDecision,
} from '../voiceV23/interruptionV23';
import { splitReplyAtCutV22 } from '../voiceV22/bargeInV22';
import {
  clampV25,
  formatDurationV25,
  isValidVoiceV25Id,
  meanV25,
  percentileV25,
  round2V25,
  VOICE_V25_BARGEIN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V25_STOP_LATENCY_SLOW_DEFAULT_MS,
  type VoiceV25BargeInKind,
  type VoiceV25BargeInRecord,
  type VoiceV25ResumeStrategy,
  type VoiceV25TurnAlert,
} from './types';

export interface BargeInV25Options {
  /** v23 policy options (grace window, backchannel, ...). */
  interruption?: Partial<InterruptionV23Options>;
  /** User speech ms below this never counts as a barge-in (default 250). */
  minUserSpeechMs: number;
  /** Stop latency past this is `slow` (default 500). */
  stopLatencySlowMs: number;
  /** Barge-ins inside this window count as one burst (default 30000). */
  burstWindowMs: number;
  /** Barge-ins in one window that raise a burst alert (default 3). */
  burstCount: number;
  /** Max barge-in records kept (oldest dropped, default 1000). */
  maxRecords: number;
}

export function defaultBargeInV25Options(): BargeInV25Options {
  return {
    interruption: {},
    minUserSpeechMs: VOICE_V25_BARGEIN_MIN_SPEECH_DEFAULT_MS,
    stopLatencySlowMs: VOICE_V25_STOP_LATENCY_SLOW_DEFAULT_MS,
    burstWindowMs: 30000,
    burstCount: 3,
    maxRecords: 1000,
  };
}

export function validateBargeInV25Options(o: Partial<BargeInV25Options>): string[] {
  const errors: string[] = [];
  if (o.minUserSpeechMs !== undefined && !(o.minUserSpeechMs >= 0 && o.minUserSpeechMs <= 5000)) {
    errors.push('minUserSpeechMs must be 0..5000');
  }
  if (o.stopLatencySlowMs !== undefined && !(o.stopLatencySlowMs >= 50 && o.stopLatencySlowMs <= 10000)) {
    errors.push('stopLatencySlowMs must be 50..10000');
  }
  if (o.burstWindowMs !== undefined && !(o.burstWindowMs >= 1000 && o.burstWindowMs <= 300000)) {
    errors.push('burstWindowMs must be 1000..300000');
  }
  if (o.burstCount !== undefined && (!Number.isInteger(o.burstCount) || o.burstCount < 2 || o.burstCount > 20)) {
    errors.push('burstCount must be an integer 2..20');
  }
  if (o.maxRecords !== undefined && (!Number.isInteger(o.maxRecords) || o.maxRecords < 10 || o.maxRecords > 100000)) {
    errors.push('maxRecords must be an integer 10..100000');
  }
  return errors;
}

/** One duck event (agent lowered volume, reply kept going). */
export interface VoiceV25DuckEvent {
  id: string;
  sessionId: string;
  turnId: string;
  turnIndex: number;
  atMs: number;
  kind: 'duck-hard' | 'duck-soft';
  userSpeechMs: number;
}

/** Aggregate barge-in statistics for a session. */
export interface VoiceV25BargeInStats {
  sessionId: string;
  interruptions: number;
  ducks: number;
  ignored: number;
  falsePositives: number;
  meanStopLatencyMs: number;
  p95StopLatencyMs: number;
  slowStops: number;
  resumed: number;
  dropped: number;
  summarised: number;
  rephrased: number;
  /** Mean share of the reply that was spoken before the cut, 0..1. */
  meanSpokenShare: number;
  burstAlerts: number;
}

/** Result of reporting a burst to the manager. */
export interface VoiceV25BurstResult {
  /** The v23 burst-level decision. */
  decision: VoiceV23InterruptionDecision;
  /** The barge-in record, when the decision was `interrupt`. */
  bargeIn: VoiceV25BargeInRecord | null;
  /** The duck event, when the decision was a duck. */
  duck: VoiceV25DuckEvent | null;
  /** True when this interruption completed a burst alert. */
  burstAlert: VoiceV25TurnAlert | null;
}

/** Result of the host reporting the agent actually stopped. */
export interface VoiceV25StopResult {
  bargeIn: VoiceV25BargeInRecord;
  /** Reply text the user actually heard (spoken prefix). */
  spokenText: string;
  /** Text to re-speak if the reply is resumed (word-start rollback). */
  reSpeakText: string;
  /** Chars rolled back to the previous word start. */
  rolledBackChars: number;
  resumeStrategy: VoiceV25ResumeStrategy;
}

export function createBargeInManagerV25(
  sessionId: string,
  opts: Partial<BargeInV25Options> = {},
): BargeInManagerV25 {
  return new BargeInManagerV25(sessionId, opts);
}

export class BargeInManagerV25 {
  readonly sessionId: string;
  private readonly opts: BargeInV25Options;
  private readonly policy: InterruptionPolicyV23;
  private readonly records: VoiceV25BargeInRecord[] = [];
  private readonly ducks: VoiceV25DuckEvent[] = [];
  private readonly alerts: VoiceV25TurnAlert[] = [];
  /** The agent reply currently being spoken, if any. */
  private speaking: {
    turnId: string;
    turnIndex: number;
    replyText: string;
    startedAtMs: number;
    spokenChars: number;
  } | null = null;
  /** A barge-in whose stop the host has not reported yet. */
  private pending: VoiceV25BargeInRecord | null = null;
  private seq = 0;
  private duckSeq = 0;
  private alertSeq = 0;
  private ignoredCount = 0;

  constructor(sessionId: string, opts: Partial<BargeInV25Options> = {}) {
    if (!isValidVoiceV25Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    const errors = validateBargeInV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid BargeInManagerV25 options: ${errors.join('; ')}`);
    }
    this.sessionId = sessionId;
    this.opts = { ...defaultBargeInV25Options(), ...opts };
    this.policy = createInterruptionPolicyV23(opts.interruption ?? {});
  }

  options(): BargeInV25Options {
    return { ...this.opts, interruption: { ...this.opts.interruption } };
  }

  /** The v23 policy this manager consults (read-only access). */
  interruptionPolicy(): InterruptionPolicyV23 {
    return this.policy;
  }

  /** Register the agent reply that is now being spoken. */
  agentStartedSpeaking(
    turnId: string,
    turnIndex: number,
    replyText: string,
    atMs: number,
  ): void {
    if (!isValidVoiceV25Id(turnId)) throw new Error(`Invalid turnId "${turnId}"`);
    if (!Number.isInteger(turnIndex) || turnIndex < 0) {
      throw new Error('turnIndex must be an integer >= 0');
    }
    if (typeof replyText !== 'string') throw new Error('replyText must be a string');
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    this.speaking = { turnId, turnIndex, replyText, startedAtMs: atMs, spokenChars: 0 };
  }

  /** Update how far the TTS engine has spoken (host-reported). */
  agentSpeechProgress(atMs: number, spokenChars: number): void {
    if (this.speaking === null) return;
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (!Number.isInteger(spokenChars) || spokenChars < 0) {
      throw new Error('spokenChars must be an integer >= 0');
    }
    this.speaking.spokenChars = Math.min(spokenChars, this.speaking.replyText.length);
  }

  /** True while an agent reply is being spoken (and not yet stopped). */
  isAgentSpeaking(): boolean {
    return this.speaking !== null && this.pending === null;
  }

  /** The reply currently being spoken, if any. */
  currentReply(): { turnId: string; turnIndex: number; replyText: string; startedAtMs: number; spokenChars: number } | null {
    return this.speaking === null ? null : { ...this.speaking };
  }

  /**
   * Report a user-speech burst while the agent may be speaking.
   * The v23 policy decides; an `interrupt` opens a pending
   * barge-in that `agentStopped` finalises. A burst shorter
   * than `minUserSpeechMs` is ignored even when v23 would
   * interrupt (too short to be a real interruption — a cough,
   * a blip) and counted as ignored.
   */
  reportBurst(input: {
    atMs: number;
    atMsIntoReply: number;
    energy: number;
    sustainMs: number;
    words: string[];
    echo?: boolean;
    confidence?: number;
    kind?: VoiceV25BargeInKind;
    userText?: string;
  }): VoiceV25BurstResult {
    if (!Number.isFinite(input.atMs) || input.atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (!Array.isArray(input.words)) throw new Error('words must be an array');
    const agentSpeaking = this.speaking !== null && this.pending === null;
    const candidate: VoiceV23InterruptionCandidate = {
      atMs: input.atMs,
      atMsIntoReply: input.atMsIntoReply,
      energy: input.energy,
      sustainMs: input.sustainMs,
      words: input.words,
      echo: input.echo,
      agentSpeaking,
      confidence: input.confidence,
    };
    const decision = this.policy.decide(candidate);
    if (decision.decision === 'ignore' || input.sustainMs < this.opts.minUserSpeechMs) {
      this.ignoredCount += 1;
      return { decision, bargeIn: null, duck: null, burstAlert: null };
    }
    if (decision.decision === 'duck-hard' || decision.decision === 'duck-soft') {
      if (!agentSpeaking || this.speaking === null) {
        return { decision, bargeIn: null, duck: null, burstAlert: null };
      }
      this.duckSeq += 1;
      const duck: VoiceV25DuckEvent = {
        id: `duck-${this.duckSeq}`,
        sessionId: this.sessionId,
        turnId: this.speaking.turnId,
        turnIndex: this.speaking.turnIndex,
        atMs: input.atMs,
        kind: decision.decision,
        userSpeechMs: input.sustainMs,
      };
      this.ducks.push(duck);
      return { decision, bargeIn: null, duck, burstAlert: null };
    }
    // interrupt — but only when there is a reply to cut.
    if (!agentSpeaking || this.speaking === null) {
      return { decision, bargeIn: null, duck: null, burstAlert: null };
    }
    this.seq += 1;
    const record: VoiceV25BargeInRecord = {
      id: `bi-${this.seq}`,
      sessionId: this.sessionId,
      turnIndex: this.speaking.turnIndex,
      turnId: this.speaking.turnId,
      atMs: input.atMs,
      kind: input.kind ?? (decision.backchannel ? 'backchannel-sustained' : 'speech'),
      decision: 'interrupt',
      userSpeechMs: input.sustainMs,
      agentSpokenMs: Math.max(0, input.atMs - this.speaking.startedAtMs),
      agentSpokenChars: this.speaking.spokenChars,
      agentPlannedChars: this.speaking.replyText.length,
      stopLatencyMs: -1,
      resumeStrategy: 'resume',
      userText: input.userText ?? null,
      interruptingTurnId: null,
      falsePositive: false,
    };
    this.pending = record;
    const burstAlert = this.maybeBurstAlert(record);
    return { decision, bargeIn: { ...record }, duck: null, burstAlert };
  }

  /**
   * The host reports the agent actually stopped speaking.
   * Finalises the pending barge-in: measured stop latency,
   * spoken prefix, word-start rollback and resume strategy.
   * Returns null when no barge-in is pending.
   */
  agentStopped(atMs: number, spokenChars: number): VoiceV25StopResult | null {
    if (this.pending === null || this.speaking === null) return null;
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (!Number.isInteger(spokenChars) || spokenChars < 0) {
      throw new Error('spokenChars must be an integer >= 0');
    }
    const record = this.pending;
    const replyText = this.speaking.replyText;
    const spoken = Math.min(spokenChars, replyText.length);
    record.stopLatencyMs = Math.max(0, atMs - record.atMs);
    record.agentSpokenChars = spoken;
    record.agentSpokenMs = Math.max(0, atMs - this.speaking.startedAtMs);
    const cut = splitReplyAtCutV22(replyText, spoken);
    const rollback = rollbackForCutV23(replyText, spoken);
    const userWords = (record.userText ?? '').split(/\s+/).filter((w) => w.length > 0);
    record.resumeStrategy = strategyForCutV23(cut, userWords, this.opts.interruption ?? {});
    this.records.push(record);
    this.pending = null;
    this.speaking = null;
    this.prune();
    return {
      bargeIn: { ...record },
      spokenText: replyText.slice(0, spoken),
      reSpeakText: rollback.reSpeakText,
      rolledBackChars: rollback.rolledBackChars,
      resumeStrategy: record.resumeStrategy,
    };
  }

  /** The pending barge-in, if the agent has not stopped yet. */
  pendingBargeIn(): VoiceV25BargeInRecord | null {
    return this.pending === null ? null : { ...this.pending };
  }

  /** Attach the new user turn that interrupted the agent. */
  attachInterruptingTurn(bargeInId: string, turnId: string): boolean {
    const record = this.records.find((r) => r.id === bargeInId)
      ?? (this.pending?.id === bargeInId ? this.pending : undefined);
    if (record === undefined) return false;
    if (!isValidVoiceV25Id(turnId)) throw new Error(`Invalid turnId "${turnId}"`);
    record.interruptingTurnId = turnId;
    return true;
  }

  /** Mark a barge-in as a false positive (operator feedback). */
  markFalsePositive(bargeInId: string): boolean {
    const record = this.records.find((r) => r.id === bargeInId);
    if (record === undefined) return false;
    record.falsePositive = true;
    return true;
  }

  get(id: string): VoiceV25BargeInRecord | null {
    const record = this.records.find((r) => r.id === id);
    return record === undefined ? null : { ...record };
  }

  list(filter: { turnIndex?: number; falsePositive?: boolean } = {}): VoiceV25BargeInRecord[] {
    return this.records
      .filter((r) => filter.turnIndex === undefined || r.turnIndex === filter.turnIndex)
      .filter((r) => filter.falsePositive === undefined || r.falsePositive === filter.falsePositive)
      .map((r) => ({ ...r }));
  }

  ducksList(): VoiceV25DuckEvent[] {
    return this.ducks.map((d) => ({ ...d }));
  }

  alertsList(): VoiceV25TurnAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  stats(): VoiceV25BargeInStats {
    const latencies = this.records
      .filter((r) => r.stopLatencyMs >= 0)
      .map((r) => r.stopLatencyMs);
    const shares = this.records
      .filter((r) => r.agentPlannedChars > 0)
      .map((r) => r.agentSpokenChars / r.agentPlannedChars);
    return {
      sessionId: this.sessionId,
      interruptions: this.records.length,
      ducks: this.ducks.length,
      ignored: this.ignoredCount,
      falsePositives: this.records.filter((r) => r.falsePositive).length,
      meanStopLatencyMs: round2V25(meanV25(latencies)),
      p95StopLatencyMs: round2V25(percentileV25(latencies, 95)),
      slowStops: this.records.filter((r) => r.stopLatencyMs >= this.opts.stopLatencySlowMs).length,
      resumed: this.records.filter((r) => r.resumeStrategy === 'resume').length,
      dropped: this.records.filter((r) => r.resumeStrategy === 'drop').length,
      summarised: this.records.filter((r) => r.resumeStrategy === 'summarise').length,
      rephrased: this.records.filter((r) => r.resumeStrategy === 'rephrase').length,
      meanSpokenShare: shares.length === 0 ? 0 : round2V25(meanV25(shares)),
      burstAlerts: this.alerts.length,
    };
  }

  count(): number {
    return this.records.length;
  }

  reset(): void {
    this.records.length = 0;
    this.ducks.length = 0;
    this.alerts.length = 0;
    this.speaking = null;
    this.pending = null;
    this.seq = 0;
    this.duckSeq = 0;
    this.alertSeq = 0;
    this.ignoredCount = 0;
  }

  private maybeBurstAlert(record: VoiceV25BargeInRecord): VoiceV25TurnAlert | null {
    // Count interruptions (already recorded + this one) inside the window.
    const windowStart = record.atMs - this.opts.burstWindowMs;
    const inWindow = this.records.filter((r) => r.atMs >= windowStart).length + 1;
    if (inWindow < this.opts.burstCount) return null;
    // One alert per window: skip when the last alert is still in-window.
    const last = this.alerts[this.alerts.length - 1];
    if (last !== undefined && last.atMs >= windowStart) return null;
    this.alertSeq += 1;
    const alert: VoiceV25TurnAlert = {
      id: `alert-${this.alertSeq}`,
      sessionId: this.sessionId,
      turnId: record.turnId,
      kind: 'barge-in-burst',
      thresholdMs: this.opts.burstCount,
      durationMs: inWindow,
      atMs: record.atMs,
      message:
        `${inWindow} barge-ins within ${formatDurationV25(this.opts.burstWindowMs)} ` +
        `in session ${this.sessionId} — user may be fighting the agent, or the detector is mis-tuned`,
    };
    this.alerts.push(alert);
    return { ...alert };
  }

  private prune(): void {
    while (this.records.length > this.opts.maxRecords) this.records.shift();
  }

  summary(): string {
    const s = this.stats();
    return (
      `Session ${this.sessionId}: ${s.interruptions} interruptions, ${s.ducks} ducks, ` +
      `${s.falsePositives} false positives, mean stop latency ${formatDurationV25(s.meanStopLatencyMs)}, ` +
      `p95 ${formatDurationV25(s.p95StopLatencyMs)}, ${s.slowStops} slow stops, ` +
      `mean spoken share ${Math.round(s.meanSpokenShare * 100)}%, ` +
      `resume ${s.resumed} / drop ${s.dropped} / summarise ${s.summarised} / rephrase ${s.rephrased}.`
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines: string[] = [`# Voice v25 barge-ins — session ${this.sessionId}`, ''];
    lines.push(
      `Interruptions: ${s.interruptions} (ducks ${s.ducks}, false positives ${s.falsePositives}); ` +
      `mean stop latency ${formatDurationV25(s.meanStopLatencyMs)}, p95 ${formatDurationV25(s.p95StopLatencyMs)}, slow stops ${s.slowStops}.`,
    );
    lines.push(`Resume: ${s.resumed} · drop: ${s.dropped} · summarise: ${s.summarised} · rephrase: ${s.rephrased}; mean spoken share ${Math.round(s.meanSpokenShare * 100)}%.`);
    if (this.records.length > 0) {
      lines.push('', '| Barge-in | Turn | At | User speech | Spoken | Stop latency | Strategy |');
      lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const r of this.records) {
        const spokenShare = r.agentPlannedChars > 0
          ? `${Math.round((r.agentSpokenChars / r.agentPlannedChars) * 100)}%`
          : '—';
        lines.push(
          `| ${r.id} | ${r.turnIndex} | ${r.atMs}ms | ${formatDurationV25(r.userSpeechMs)} | ${spokenShare} | ` +
          `${r.stopLatencyMs < 0 ? 'pending' : formatDurationV25(r.stopLatencyMs)} | ${r.resumeStrategy}${r.falsePositive ? ' (false +)' : ''} |`,
        );
      }
    }
    if (this.alerts.length > 0) {
      lines.push('', '## Alerts');
      for (const a of this.alerts) lines.push(`- [${a.kind}] ${a.message}`);
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV25 };
