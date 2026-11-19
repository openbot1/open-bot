/**
 * Barge-in v2: interrupt policy + event log (voice v27).
 *
 * v26 detects a barge-in frame by frame. v27 decides whether an
 * interruption is *allowed* and what happens to the cut reply:
 *
 *   - policy modes: `always` (any sustained speech interrupts),
 *     `keyword-only` (only a configured keyword — e.g. "dừng lại" /
 *     "stop" — interrupts), `never-critical` (critical turns, such
 *     as reading a one-time code, cannot be interrupted),
 *     `disabled` (the user must wait for the reply to finish);
 *   - grace window: speech in the first N ms after the agent
 *     starts is ignored (the user was still finishing, or the
 *     mic caught the reply onset);
 *   - cooldown: after a stop, the next interruption is ignored
 *     for N ms so one burst cannot stop the reply twice;
 *   - minimum speech: bursts shorter than N ms are backchannels
 *     ("ừ", "mm-hm") or noise, never interruptions;
 *   - storm protection: more than N confirmed interruptions
 *     inside a window means the user is fighting the voice —
 *     further bursts are blocked for a storm cooldown and the
 *     event is logged, so the host can suggest switching to text;
 *   - stop orchestration: the stop records measured stop
 *     latency, cuts the spoken prefix at a word boundary, keeps
 *     the unspoken remainder, and picks a resume strategy from
 *     how much was already spoken;
 *   - event log: every burst — confirmed, ignored, storm-
 *     blocked, false positive — is kept as a plain-JSON record
 *     with reason, timings and resume decision.
 *
 * No audio is produced or consumed here: bursts arrive as
 * caller-measured speech durations, the TTS stop is a caller-
 * measured latency. All clocks virtual.
 */
import {
  clampV27,
  cutAtWordBoundaryV27,
  formatDurationV27,
  meanV27,
  percentileV27,
  resumeDecisionForSpokenFractionV27,
  round2V27,
  VOICE_V27_BACKCHANNEL_MAX_DEFAULT_MS,
  VOICE_V27_GRACE_AFTER_REPLY_START_DEFAULT_MS,
  VOICE_V27_INTERRUPT_COOLDOWN_DEFAULT_MS,
  VOICE_V27_MAX_INTERRUPT_EVENTS_DEFAULT,
  VOICE_V27_MIN_INTERRUPT_SPEECH_DEFAULT_MS,
  VOICE_V27_STOP_LATENCY_SLOW_DEFAULT_MS,
  VOICE_V27_STORM_COOLDOWN_DEFAULT_MS,
  VOICE_V27_STORM_THRESHOLD_DEFAULT,
  VOICE_V27_STORM_WINDOW_DEFAULT_MS,
  type VoiceV27InterruptDecision,
  type VoiceV27InterruptEvent,
  type VoiceV27InterruptFeedResult,
  type VoiceV27InterruptIgnoreReason,
  type VoiceV27InterruptKind,
  type VoiceV27InterruptMode,
  type VoiceV27InterruptStopResult,
  type VoiceV27ResumeDecision,
} from './types';

export interface InterruptPolicyV27Options {
  /** Policy mode (default 'always'). */
  mode: VoiceV27InterruptMode;
  /** Ignore speech in this window after the agent starts (ms). */
  graceAfterReplyStartMs: number;
  /** Ignore interruptions for this long after a stop (ms). */
  cooldownMs: number;
  /** Bursts shorter than this never interrupt (ms). */
  minSpeechMs: number;
  /** Bursts up to this long with no content count as backchannel (ms). */
  backchannelMaxMs: number;
  /** Window for storm counting (ms). */
  stormWindowMs: number;
  /** Confirmed interruptions inside the window that trigger storm mode. */
  stormThreshold: number;
  /** How long storm mode blocks interruptions (ms). */
  stormCooldownMs: number;
  /** Stop slower than this is flagged slow (ms). */
  stopLatencySlowMs: number;
  /** Max events kept in the log (oldest dropped). */
  maxEvents: number;
  /** Keywords that interrupt in `keyword-only` mode. */
  keywords: string[];
  /** Session id the policy belongs to. */
  sessionId: string;
}

export function defaultInterruptPolicyV27Options(sessionId = ''): InterruptPolicyV27Options {
  return {
    mode: 'always',
    graceAfterReplyStartMs: VOICE_V27_GRACE_AFTER_REPLY_START_DEFAULT_MS,
    cooldownMs: VOICE_V27_INTERRUPT_COOLDOWN_DEFAULT_MS,
    minSpeechMs: VOICE_V27_MIN_INTERRUPT_SPEECH_DEFAULT_MS,
    backchannelMaxMs: VOICE_V27_BACKCHANNEL_MAX_DEFAULT_MS,
    stormWindowMs: VOICE_V27_STORM_WINDOW_DEFAULT_MS,
    stormThreshold: VOICE_V27_STORM_THRESHOLD_DEFAULT,
    stormCooldownMs: VOICE_V27_STORM_COOLDOWN_DEFAULT_MS,
    stopLatencySlowMs: VOICE_V27_STOP_LATENCY_SLOW_DEFAULT_MS,
    maxEvents: VOICE_V27_MAX_INTERRUPT_EVENTS_DEFAULT,
    keywords: ['stop', 'dừng lại', 'dừng', 'khoan', 'wait'],
    sessionId,
  };
}

export function validateInterruptPolicyV27Options(
  opts: Partial<InterruptPolicyV27Options>,
): string[] {
  const errors: string[] = [];
  const checkMs = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return;
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${name} must be ${min}..${max}ms`);
  };
  if (opts.mode !== undefined && !['always', 'keyword-only', 'never-critical', 'disabled'].includes(opts.mode)) {
    errors.push(`mode must be always | keyword-only | never-critical | disabled`);
  }
  checkMs('graceAfterReplyStartMs', opts.graceAfterReplyStartMs, 0, 10_000);
  checkMs('cooldownMs', opts.cooldownMs, 0, 30_000);
  checkMs('minSpeechMs', opts.minSpeechMs, 0, 5_000);
  checkMs('backchannelMaxMs', opts.backchannelMaxMs, 0, 5_000);
  checkMs('stormWindowMs', opts.stormWindowMs, 1_000, 120_000);
  checkMs('stormCooldownMs', opts.stormCooldownMs, 0, 60_000);
  checkMs('stopLatencySlowMs', opts.stopLatencySlowMs, 0, 10_000);
  if (opts.stormThreshold !== undefined && (!Number.isInteger(opts.stormThreshold) || opts.stormThreshold < 2 || opts.stormThreshold > 50)) {
    errors.push('stormThreshold must be an integer 2..50');
  }
  if (opts.maxEvents !== undefined && (!Number.isInteger(opts.maxEvents) || opts.maxEvents < 10 || opts.maxEvents > 10_000)) {
    errors.push('maxEvents must be an integer 10..10000');
  }
  if (opts.keywords !== undefined) {
    if (!Array.isArray(opts.keywords) || opts.keywords.some((k) => typeof k !== 'string' || k.trim() === '')) {
      errors.push('keywords must be an array of non-empty strings');
    }
  }
  return errors;
}

export interface VoiceV27InterruptStats {
  sessionId: string;
  events: number;
  confirmed: number;
  ignored: number;
  stormBlocked: number;
  falsePositives: number;
  backchannels: number;
  meanDecisionMs: number;
  p95DecisionMs: number;
  meanStopLatencyMs: number;
  p95StopLatencyMs: number;
  slowStops: number;
  storms: number;
  stormActive: boolean;
  mode: VoiceV27InterruptMode;
  byKind: Record<VoiceV27InterruptKind, number>;
  byIgnoreReason: Partial<Record<VoiceV27InterruptIgnoreReason, number>>;
}

export interface VoiceV27ArmedReply {
  turnId: string;
  replyText: string;
  critical: boolean;
  startedAtMs: number;
  spokenChars: number;
}

export function createInterruptPolicyV27(
  sessionId: string,
  opts: Partial<InterruptPolicyV27Options> = {},
): InterruptPolicyV27 {
  return new InterruptPolicyV27(sessionId, opts);
}

export class InterruptPolicyV27 {
  readonly sessionId: string;
  private opts: InterruptPolicyV27Options;
  private armed: VoiceV27ArmedReply | null = null;
  private events: VoiceV27InterruptEvent[] = [];
  private seq = 0;
  private lastStopAtMs: number | null = null;
  private stormUntilMs: number | null = null;
  private storms = 0;
  private confirmedAtMs: number[] = [];

  constructor(sessionId: string, opts: Partial<InterruptPolicyV27Options> = {}) {
    const errors = validateInterruptPolicyV27Options(opts);
    if (errors.length > 0) throw new Error(`Invalid InterruptPolicyV27 options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultInterruptPolicyV27Options(sessionId), ...opts, sessionId };
  }

  policyNow(): InterruptPolicyV27Options {
    return { ...this.opts, keywords: [...this.opts.keywords] };
  }

  setPolicy(partial: Partial<Omit<InterruptPolicyV27Options, 'sessionId'>>): InterruptPolicyV27Options {
    const errors = validateInterruptPolicyV27Options(partial);
    if (errors.length > 0) throw new Error(`Invalid InterruptPolicyV27 options: ${errors.join('; ')}`);
    this.opts = { ...this.opts, ...partial };
    return this.policyNow();
  }

  setMode(mode: VoiceV27InterruptMode, atMs = 0): InterruptPolicyV27Options {
    void atMs;
    return this.setPolicy({ mode });
  }

  isAgentSpeaking(): boolean {
    return this.armed !== null;
  }

  armedReply(): VoiceV27ArmedReply | null {
    return this.armed === null ? null : { ...this.armed };
  }

  armReply(input: { turnId: string; replyText: string; critical?: boolean; atMs: number }): VoiceV27ArmedReply {
    if (typeof input.turnId !== 'string' || input.turnId === '') throw new Error('turnId must be a non-empty string');
    if (typeof input.replyText !== 'string' || input.replyText === '') throw new Error('replyText must be a non-empty string');
    this.armed = {
      turnId: input.turnId,
      replyText: input.replyText,
      critical: input.critical ?? false,
      startedAtMs: input.atMs,
      spokenChars: 0,
    };
    return { ...this.armed };
  }

  noteProgress(atMs: number, spokenChars: number): void {
    void atMs;
    if (this.armed === null) return;
    this.armed.spokenChars = clampV27(spokenChars, 0, this.armed.replyText.length);
  }

  /** ms until the next interruption may be accepted (0 = now). */
  cooldownRemainingMs(atMs: number): number {
    if (this.stormUntilMs !== null && atMs < this.stormUntilMs) return this.stormUntilMs - atMs;
    if (this.lastStopAtMs === null) return 0;
    return Math.max(0, this.lastStopAtMs + this.opts.cooldownMs - atMs);
  }

  stormActiveNow(atMs: number): boolean {
    return this.stormUntilMs !== null && atMs < this.stormUntilMs;
  }

  private newEvent(input: {
    kind: VoiceV27InterruptKind;
    decision: VoiceV27InterruptDecision;
    ignoreReason: VoiceV27InterruptIgnoreReason | null;
    speechMs: number;
    peakEnergy: number;
    startedAtMs: number;
    turnId: string | null;
    userText: string | null;
  }): VoiceV27InterruptEvent {
    this.seq += 1;
    const event: VoiceV27InterruptEvent = {
      id: `v27-int-${this.seq}`,
      sessionId: this.sessionId,
      turnId: input.turnId,
      kind: input.kind,
      decision: input.decision,
      ignoreReason: input.ignoreReason,
      speechMs: input.speechMs,
      peakEnergy: round2V27(clampV27(input.peakEnergy, 0, 1)),
      decisionMs: null,
      stopLatencyMs: null,
      spokenChars: null,
      spokenText: null,
      remainingText: null,
      resume: null,
      userText: input.userText,
      startedAtMs: input.startedAtMs,
      decidedAtMs: null,
      stoppedAtMs: null,
      falsePositive: false,
    };
    this.events.push(event);
    while (this.events.length > this.opts.maxEvents) this.events.shift();
    return event;
  }

  private recordStorm(atMs: number): void {
    this.storms += 1;
    this.stormUntilMs = atMs + this.opts.stormCooldownMs;
    this.confirmedAtMs = [];
  }

  private checkStorm(atMs: number): boolean {
    const windowStart = atMs - this.opts.stormWindowMs;
    this.confirmedAtMs = this.confirmedAtMs.filter((t) => t >= windowStart);
    if (this.confirmedAtMs.length >= this.opts.stormThreshold) {
      this.recordStorm(atMs);
      return true;
    }
    return false;
  }

  /**
   * Feed one user speech burst (caller-measured) while the agent
   * may be speaking. Returns the policy decision; a confirmed
   * burst must still be stopped via stop() (measured latency).
   */
  feedBurst(input: {
    atMs: number;
    speechMs: number;
    energy?: number;
    text?: string | null;
    isKeyword?: boolean;
  }): VoiceV27InterruptFeedResult {
    const atMs = input.atMs;
    const speechMs = Math.max(0, input.speechMs);
    const energy = clampV27(input.energy ?? 0, 0, 1);
    const text = input.text ?? null;
    const turnId = this.armed?.turnId ?? null;
    const burstStartMs = atMs - speechMs;
    const isKeyword = input.isKeyword ?? this.matchesKeyword(text);

    const ignore = (reason: VoiceV27InterruptIgnoreReason, kind: VoiceV27InterruptKind): VoiceV27InterruptFeedResult => {
      const event = this.newEvent({
        kind, decision: 'ignored', ignoreReason: reason, speechMs, peakEnergy: energy,
        startedAtMs: burstStartMs, turnId, userText: text,
      });
      event.decidedAtMs = atMs;
      event.decisionMs = speechMs;
      return {
        decision: 'ignored', ignoreReason: reason, eventId: event.id,
        confirmed: false, stormBlocked: false, cooldownRemainingMs: this.cooldownRemainingMs(atMs),
      };
    };

    // Storm protection first: a fighting user is blocked, not stopped.
    if (this.stormActiveNow(atMs)) {
      const event = this.newEvent({
        kind: isKeyword ? 'keyword' : 'speech', decision: 'storm-blocked', ignoreReason: 'storm',
        speechMs, peakEnergy: energy, startedAtMs: burstStartMs, turnId, userText: text,
      });
      event.decidedAtMs = atMs;
      event.decisionMs = speechMs;
      return {
        decision: 'storm-blocked', ignoreReason: 'storm', eventId: event.id,
        confirmed: false, stormBlocked: true, cooldownRemainingMs: this.cooldownRemainingMs(atMs),
      };
    }
    if (this.opts.mode === 'disabled') return ignore('mode-disabled', 'speech');
    if (this.armed === null) return ignore('not-speaking', 'speech');
    if (speechMs < this.opts.minSpeechMs) {
      // Short burst: backchannel ("ừ", "mm-hm") or plain noise.
      const kind: VoiceV27InterruptKind = speechMs <= this.opts.backchannelMaxMs && energy >= 0.15 ? 'backchannel' : 'noise';
      return ignore(kind === 'backchannel' ? 'backchannel' : 'too-short', kind);
    }
    if (atMs - this.armed.startedAtMs < this.opts.graceAfterReplyStartMs) {
      return ignore('grace-period', 'speech');
    }
    const cooldown = this.cooldownRemainingMs(atMs);
    if (cooldown > 0) return ignore('cooldown', 'speech');
    if (this.opts.mode === 'keyword-only' && !isKeyword) return ignore('not-keyword', 'speech');
    if (this.opts.mode === 'never-critical' && this.armed.critical) {
      return ignore('critical-turn', 'speech');
    }

    // Confirmed: record the event, count towards storm detection.
    const event = this.newEvent({
      kind: isKeyword ? 'keyword' : 'speech', decision: 'confirmed', ignoreReason: null,
      speechMs, peakEnergy: energy, startedAtMs: burstStartMs, turnId, userText: text,
    });
    event.decidedAtMs = atMs;
    event.decisionMs = Math.max(0, atMs - burstStartMs);
    this.confirmedAtMs.push(atMs);
    this.checkStorm(atMs);
    return {
      decision: 'confirmed', ignoreReason: null, eventId: event.id,
      confirmed: true, stormBlocked: false, cooldownRemainingMs: 0,
    };
  }

  matchesKeyword(text: string | null | undefined): boolean {
    if (!text) return false;
    const lowered = text.toLowerCase();
    return this.opts.keywords.some((k) => lowered.includes(k.toLowerCase()));
  }

  /** Stop the TTS for a confirmed event (caller-measured latency). */
  stop(input: {
    eventId: string;
    atMs: number;
    spokenChars?: number | null;
    stopLatencyMs?: number | null;
    userText?: string | null;
  }): VoiceV27InterruptStopResult | null {
    const event = this.events.find((e) => e.id === input.eventId);
    if (!event || event.decision !== 'confirmed' || event.stoppedAtMs !== null) return null;
    const reply = this.armed;
    const replyText = reply?.replyText ?? event.remainingText ?? '';
    const spokenChars = clampV27(input.spokenChars ?? reply?.spokenChars ?? 0, 0, replyText.length);
    const spokenText = cutAtWordBoundaryV27(replyText, spokenChars);
    const remainingText = replyText.slice(spokenText.length).trimStart();
    const spokenFraction = replyText.length === 0 ? 0 : spokenChars / replyText.length;
    const resume = resumeDecisionForSpokenFractionV27(spokenFraction);
    const stopLatencyMs = Math.max(0, input.stopLatencyMs ?? 0);
    event.stoppedAtMs = input.atMs;
    event.stopLatencyMs = stopLatencyMs;
    event.spokenChars = spokenChars;
    event.spokenText = spokenText;
    event.remainingText = remainingText;
    event.resume = resume;
    if (input.userText !== undefined && input.userText !== null) event.userText = input.userText;
    this.lastStopAtMs = input.atMs;
    this.armed = null;
    return {
      eventId: event.id,
      stoppedAtMs: input.atMs,
      stopLatencyMs,
      spokenChars,
      spokenText,
      remainingText,
      resume,
      slow: stopLatencyMs > this.opts.stopLatencySlowMs,
    };
  }

  /** The current confirmed-but-not-yet-stopped event, if any. */
  currentConfirmed(): VoiceV27InterruptEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.decision === 'confirmed' && e.stoppedAtMs === null) return { ...e };
    }
    return null;
  }

  get(eventId: string): VoiceV27InterruptEvent | null {
    const found = this.events.find((e) => e.id === eventId);
    return found === undefined ? null : { ...found };
  }

  list(): VoiceV27InterruptEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  confirmedList(): VoiceV27InterruptEvent[] {
    return this.list().filter((e) => e.decision === 'confirmed');
  }

  ignoredList(): VoiceV27InterruptEvent[] {
    return this.list().filter((e) => e.decision !== 'confirmed');
  }

  markFalsePositive(eventId: string): boolean {
    const found = this.events.find((e) => e.id === eventId);
    if (!found) return false;
    found.falsePositive = true;
    return true;
  }

  stats(atMs = 0): VoiceV27InterruptStats {
    const confirmed = this.events.filter((e) => e.decision === 'confirmed');
    const decisionMs = confirmed.map((e) => e.decisionMs ?? 0);
    const stopMs = confirmed.filter((e) => e.stopLatencyMs !== null).map((e) => e.stopLatencyMs as number);
    const byKind: Record<VoiceV27InterruptKind, number> = { speech: 0, keyword: 0, backchannel: 0, noise: 0 };
    const byIgnoreReason: Partial<Record<VoiceV27InterruptIgnoreReason, number>> = {};
    for (const e of this.events) {
      byKind[e.kind] += 1;
      if (e.ignoreReason !== null) byIgnoreReason[e.ignoreReason] = (byIgnoreReason[e.ignoreReason] ?? 0) + 1;
    }
    return {
      sessionId: this.sessionId,
      events: this.events.length,
      confirmed: confirmed.length,
      ignored: this.events.filter((e) => e.decision === 'ignored').length,
      stormBlocked: this.events.filter((e) => e.decision === 'storm-blocked').length,
      falsePositives: this.events.filter((e) => e.falsePositive).length,
      backchannels: this.events.filter((e) => e.kind === 'backchannel').length,
      meanDecisionMs: round2V27(meanV27(decisionMs)),
      p95DecisionMs: round2V27(percentileV27(decisionMs, 95)),
      meanStopLatencyMs: round2V27(meanV27(stopMs)),
      p95StopLatencyMs: round2V27(percentileV27(stopMs, 95)),
      slowStops: stopMs.filter((ms) => ms > this.opts.stopLatencySlowMs).length,
      storms: this.storms,
      stormActive: this.stormActiveNow(atMs),
      mode: this.opts.mode,
      byKind,
      byIgnoreReason,
    };
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Interrupt policy v27',
      '',
      `- Session: ${this.sessionId}`,
      `- Mode: ${s.mode} · grace ${this.opts.graceAfterReplyStartMs}ms · cooldown ${this.opts.cooldownMs}ms · min speech ${this.opts.minSpeechMs}ms`,
      `- Events: ${s.events} (${s.confirmed} confirmed, ${s.ignored} ignored, ${s.stormBlocked} storm-blocked, ${s.falsePositives} false positives)`,
      `- Mean decision: ${formatDurationV27(s.meanDecisionMs)} · p95 ${formatDurationV27(s.p95DecisionMs)}`,
      `- Mean stop latency: ${formatDurationV27(s.meanStopLatencyMs)} · p95 ${formatDurationV27(s.p95StopLatencyMs)} · slow stops: ${s.slowStops}`,
      `- Storms: ${s.storms}${s.stormActive ? ' (storm active now)' : ''}`,
      '',
      '| id | kind | decision | speech | stop latency | resume |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const e of this.events.slice(-20)) {
      lines.push(`| ${e.id} | ${e.kind} | ${e.decision} | ${formatDurationV27(e.speechMs)} | ${formatDurationV27(e.stopLatencyMs)} | ${e.resume ?? '-'} |`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.armed = null;
    this.events = [];
    this.seq = 0;
    this.lastStopAtMs = null;
    this.stormUntilMs = null;
    this.storms = 0;
    this.confirmedAtMs = [];
  }
}
