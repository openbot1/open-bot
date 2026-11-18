/**
 * Recovery engine v22 (voice v22, v1.35 Team T5).
 *
 * A durable session must notice it is broken before the user
 * does, and come back on its own. The recovery engine owns
 * that loop:
 *
 *   live ──heartbeat──► degraded (late heartbeats)
 *        ──timeout───► disconnected ──backoff──► reconnecting
 *        ──ok────────► resuming ──► recovered ──► live
 *        ──exhausted─► closed (gave up, after N attempts)
 *
 *   - Heartbeats. The transport (mock in v22) reports a beat
 *     with a round-trip time. Beats older than the timeout move
 *     the session to degraded; beats older than the hard
 *     timeout move it to disconnected. The engine never trusts
 *     a single missed beat — it needs the gap to exceed the
 *     threshold, so a scheduling hiccup does not kill a call.
 *   - Backoff. Reconnect attempts wait an exponential delay
 *     (base × 2^attempt, capped, with a deterministic jitter
 *     derived from the attempt number so tests stay stable).
 *     Attempts are capped; after the cap the session gives up
 *     and reports the failure instead of retrying forever.
 *   - Degradation. While degraded the session sheds load in
 *     order: TTS cache first (re-synthesise instead of serving
 *     from cache), then the monitor panel (snapshot less
 *     often), then long replies (summarised). Each shed step is
 *     recorded so the panel can show what the session gave up.
 *   - Error taxonomy. Every failure is a VoiceV22Failure with
 *     a kind, a message, a journal seq and a recoverable flag.
 *     Unrecoverable failures (corrupt checkpoint, expired
 *     token) stop the loop at once; recoverable ones feed the
 *     backoff.
 *
 * The engine is transport-agnostic: the host feeds it heartbeat
 * results and reconnect outcomes, and it decides the phase.
 * A mock transport is included so tests (and the tools layer)
 * can drive the whole loop without a network.
 */
import {
  clampV22,
  round2V22,
  type VoiceV22DurabilityPhase,
  type VoiceV22EventSink,
  type VoiceV22Failure,
  type VoiceV22FailureKind,
} from './types';

export interface VoiceV22RecoveryOptions {
  /** Heartbeat interval the host should aim for (default 5000 ms). */
  heartbeatIntervalMs: number;
  /** No beat for this long → degraded (default 10_000 ms). */
  degradedAfterMs: number;
  /** No beat for this long → disconnected (default 20_000 ms). */
  disconnectAfterMs: number;
  /** Base reconnect delay (default 1000 ms). */
  backoffBaseMs: number;
  /** Max reconnect delay (default 30_000 ms). */
  backoffMaxMs: number;
  /** Max reconnect attempts before giving up (default 5). */
  maxReconnectAttempts: number;
  /** RTT above this counts the beat as late (default 2000 ms). */
  lateRttMs: number;
}

export function defaultRecoveryV22Options(): VoiceV22RecoveryOptions {
  return {
    heartbeatIntervalMs: 5000,
    degradedAfterMs: 10_000,
    disconnectAfterMs: 20_000,
    backoffBaseMs: 1000,
    backoffMaxMs: 30_000,
    maxReconnectAttempts: 5,
    lateRttMs: 2000,
  };
}

export function validateRecoveryV22Options(o: Partial<VoiceV22RecoveryOptions>): string[] {
  const e: string[] = [];
  if (o.heartbeatIntervalMs !== undefined && (o.heartbeatIntervalMs < 500 || o.heartbeatIntervalMs > 60_000)) {
    e.push('heartbeatIntervalMs must be 500..60000');
  }
  if (o.degradedAfterMs !== undefined && o.degradedAfterMs <= 0) e.push('degradedAfterMs must be positive');
  if (o.disconnectAfterMs !== undefined && o.disconnectAfterMs <= 0) e.push('disconnectAfterMs must be positive');
  if (o.degradedAfterMs !== undefined && o.disconnectAfterMs !== undefined && o.disconnectAfterMs <= o.degradedAfterMs) {
    e.push('disconnectAfterMs must be above degradedAfterMs');
  }
  if (o.backoffBaseMs !== undefined && (o.backoffBaseMs < 100 || o.backoffBaseMs > 10_000)) {
    e.push('backoffBaseMs must be 100..10000');
  }
  if (o.backoffMaxMs !== undefined && (o.backoffMaxMs < 1000 || o.backoffMaxMs > 300_000)) {
    e.push('backoffMaxMs must be 1000..300000');
  }
  if (o.maxReconnectAttempts !== undefined && (!Number.isInteger(o.maxReconnectAttempts) || o.maxReconnectAttempts < 1)) {
    e.push('maxReconnectAttempts must be a positive integer');
  }
  if (o.lateRttMs !== undefined && o.lateRttMs <= 0) e.push('lateRttMs must be positive');
  return e;
}

/** Load-shedding steps, in the order they are applied. */
export type VoiceV22DegradationStep = 'tts-cache-off' | 'panel-throttled' | 'replies-summarised';

export interface VoiceV22Heartbeat {
  atMs: number;
  /** Round-trip time of the beat, ms. */
  rttMs: number;
  ok: boolean;
}

export interface VoiceV22ReconnectAttempt {
  attempt: number;
  atMs: number;
  delayMs: number;
  outcome: 'success' | 'failure';
  failureKind?: VoiceV22FailureKind;
}

export interface VoiceV22RecoveryStats {
  phase: VoiceV22DurabilityPhase;
  heartbeats: number;
  lateBeats: number;
  missedBeats: number;
  disconnects: number;
  reconnectAttempts: number;
  reconnectSuccesses: number;
  recoveries: number;
  gaveUp: boolean;
  meanRttMs: number;
  maxRttMs: number;
  degradationSteps: VoiceV22DegradationStep[];
}

/**
 * Deterministic backoff delay for an attempt (1-based): base ×
 * 2^(attempt-1), capped, plus a small deterministic jitter so
 * two sessions do not retry in lockstep. No randomness — the
 * jitter is attempt * 37 ms mod 250, so tests are stable.
 */
export function backoffDelayV22(attempt: number, opts: Partial<VoiceV22RecoveryOptions> = {}): number {
  const o = { ...defaultRecoveryV22Options(), ...opts };
  const exponential = o.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = (attempt * 37) % 250;
  return Math.min(o.backoffMaxMs, Math.round(exponential) + jitter);
}

/** Failures that can never be recovered by retrying. */
export const VOICE_V22_UNRECOVERABLE_FAILURES: VoiceV22FailureKind[] = [
  'checkpoint-corrupt',
  'resume-token-expired',
  'resume-token-unknown',
];

export function isRecoverableFailureV22(kind: VoiceV22FailureKind): boolean {
  return !VOICE_V22_UNRECOVERABLE_FAILURES.includes(kind);
}

export function makeFailureV22(
  kind: VoiceV22FailureKind,
  atMs: number,
  message: string,
  journalSeq = -1,
): VoiceV22Failure {
  return { kind, atMs, message, journalSeq, recoverable: isRecoverableFailureV22(kind) };
}

export class RecoveryEngineV22 {
  private readonly opts: VoiceV22RecoveryOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly sessionId: string;
  private phase: VoiceV22DurabilityPhase = 'live';
  private lastBeatAtMs: number | null = null;
  private lastBeatRttMs: number | null = null;
  private heartbeats = 0;
  private lateBeats = 0;
  private missedBeats = 0;
  private disconnects = 0;
  private readonly attempts: VoiceV22ReconnectAttempt[] = [];
  private recoveries = 0;
  private gaveUp = false;
  private readonly rtts: number[] = [];
  private readonly degradationSteps: VoiceV22DegradationStep[] = [];
  private readonly failures: VoiceV22Failure[] = [];
  private nextAttemptAtMs: number | null = null;

  constructor(sessionId: string, opts: Partial<VoiceV22RecoveryOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultRecoveryV22Options(), ...opts };
    this.sink = sink;
  }

  phaseNow(): VoiceV22DurabilityPhase {
    return this.phase;
  }

  lastBeat(): { atMs: number; rttMs: number } | null {
    return this.lastBeatAtMs === null ? null : { atMs: this.lastBeatAtMs, rttMs: this.lastBeatRttMs ?? 0 };
  }

  /** Record one heartbeat. Returns the phase after the beat. */
  heartbeat(beat: VoiceV22Heartbeat): VoiceV22DurabilityPhase {
    this.heartbeats += 1;
    if (!beat.ok) {
      this.missedBeats += 1;
      return this.phase;
    }
    this.lastBeatAtMs = beat.atMs;
    this.lastBeatRttMs = beat.rttMs;
    this.rtts.push(beat.rttMs);
    if (beat.rttMs > this.opts.lateRttMs) this.lateBeats += 1;
    if (this.phase === 'degraded' || this.phase === 'reconnecting' || this.phase === 'resuming') {
      this.setPhase('live', beat.atMs);
      this.degradationSteps.length = 0;
    }
    return this.phase;
  }

  /**
   * Check the clock: move live → degraded → disconnected as
   * beats go stale. Returns the phase after the check. The
   * host calls this when it advances the virtual clock.
   */
  checkClock(atMs: number): VoiceV22DurabilityPhase {
    if (this.phase === 'closed' || this.phase === 'recovered') return this.phase;
    if (this.lastBeatAtMs === null) return this.phase;
    const silentMs = atMs - this.lastBeatAtMs;
    if (this.phase === 'live' && silentMs > this.opts.degradedAfterMs) {
      this.setPhase('degraded', atMs);
      this.applyDegradation('tts-cache-off', atMs);
    }
    if ((this.phase === 'live' || this.phase === 'degraded') && silentMs > this.opts.disconnectAfterMs) {
      this.disconnects += 1;
      this.setPhase('disconnected', atMs);
      this.applyDegradation('panel-throttled', atMs);
      this.applyDegradation('replies-summarised', atMs);
      this.scheduleNextAttempt(atMs);
      this.sink?.({
        kind: 'disconnect',
        atMs,
        sessionId: this.sessionId,
        detail: { silentMs, disconnects: this.disconnects },
      });
    }
    return this.phase;
  }

  /** Force a disconnect (transport reported the loss). */
  markDisconnected(atMs: number, kind: VoiceV22FailureKind, message: string, journalSeq = -1): VoiceV22Failure {
    const failure = makeFailureV22(kind, atMs, message, journalSeq);
    this.failures.push(failure);
    if (this.phase !== 'disconnected' && this.phase !== 'closed') {
      this.disconnects += 1;
      this.setPhase('disconnected', atMs);
      this.scheduleNextAttempt(atMs);
      this.sink?.({
        kind: 'disconnect',
        atMs,
        sessionId: this.sessionId,
        detail: { kind, message, disconnects: this.disconnects },
      });
    }
    return { ...failure };
  }

  private scheduleNextAttempt(atMs: number): void {
    const attempt = this.attempts.length + 1;
    if (attempt > this.opts.maxReconnectAttempts) {
      this.gaveUp = true;
      this.setPhase('closed', atMs);
      this.sink?.({
        kind: 'recovery-failed',
        atMs,
        sessionId: this.sessionId,
        detail: { reason: `reconnect attempts exhausted (${this.opts.maxReconnectAttempts})` },
      });
      return;
    }
    this.nextAttemptAtMs = atMs + backoffDelayV22(attempt, this.opts);
  }

  /** When the next reconnect attempt is due (null when none scheduled). */
  nextAttemptAt(): number | null {
    return this.nextAttemptAtMs;
  }

  /** True when a reconnect attempt is due at `atMs`. */
  attemptDue(atMs: number): boolean {
    return this.phase === 'disconnected' && this.nextAttemptAtMs !== null && atMs >= this.nextAttemptAtMs;
  }

  /**
   * Report a reconnect attempt outcome. Success moves the
   * session to `reconnecting` (the resume engine then takes
   * over); failure schedules the next attempt or gives up.
   */
  reportAttempt(atMs: number, outcome: 'success' | 'failure', failureKind?: VoiceV22FailureKind): VoiceV22DurabilityPhase {
    const attemptNo = this.attempts.length + 1;
    const delayMs = this.nextAttemptAtMs === null ? 0 : Math.max(0, atMs - (this.nextAttemptAtMs - backoffDelayV22(attemptNo, this.opts)));
    this.attempts.push({ attempt: attemptNo, atMs, delayMs, outcome, ...(failureKind !== undefined ? { failureKind } : {}) });
    if (outcome === 'success') {
      this.setPhase('reconnecting', atMs);
      this.sink?.({ kind: 'reconnect', atMs, sessionId: this.sessionId, detail: { attempt: attemptNo } });
      return this.phase;
    }
    if (failureKind !== undefined) {
      const failure = makeFailureV22(failureKind, atMs, `reconnect attempt ${attemptNo} failed: ${failureKind}`);
      this.failures.push(failure);
      if (!failure.recoverable) {
        this.gaveUp = true;
        this.setPhase('closed', atMs);
        this.sink?.({
          kind: 'recovery-failed',
          atMs,
          sessionId: this.sessionId,
          detail: { reason: failure.message },
        });
        return this.phase;
      }
    }
    this.setPhase('disconnected', atMs);
    this.scheduleNextAttempt(atMs);
    return this.phase;
  }

  /** The resume engine finished: mark the session recovered. */
  markResumed(atMs: number, withGaps: boolean): VoiceV22DurabilityPhase {
    this.recoveries += 1;
    this.nextAttemptAtMs = null;
    this.degradationSteps.length = 0;
    this.setPhase(withGaps ? 'recovered' : 'live', atMs);
    this.sink?.({
      kind: 'recovered',
      atMs,
      sessionId: this.sessionId,
      detail: { withGaps, recoveries: this.recoveries },
    });
    return this.phase;
  }

  /** A recovered session returns to live once it has spoken again. */
  markLive(atMs: number): VoiceV22DurabilityPhase {
    if (this.phase === 'recovered') this.setPhase('live', atMs);
    return this.phase;
  }

  private setPhase(phase: VoiceV22DurabilityPhase, atMs: number): void {
    if (this.phase === phase) return;
    const from = this.phase;
    this.phase = phase;
    if (phase === 'degraded') {
      this.sink?.({ kind: 'degraded', atMs, sessionId: this.sessionId, detail: { from } });
    }
  }

  /** Apply one load-shedding step (idempotent, in order). */
  applyDegradation(step: VoiceV22DegradationStep, atMs: number): void {
    if (this.degradationSteps.includes(step)) return;
    const order: VoiceV22DegradationStep[] = ['tts-cache-off', 'panel-throttled', 'replies-summarised'];
    // Steps apply in order: never skip ahead.
    const expected = order[this.degradationSteps.length];
    if (step !== expected) return;
    this.degradationSteps.push(step);
    this.sink?.({
      kind: 'degraded',
      atMs,
      sessionId: this.sessionId,
      detail: { step, steps: [...this.degradationSteps] },
    });
  }

  degradation(): VoiceV22DegradationStep[] {
    return [...this.degradationSteps];
  }

  isDegraded(step: VoiceV22DegradationStep): boolean {
    return this.degradationSteps.includes(step);
  }

  failuresHistory(): VoiceV22Failure[] {
    return this.failures.map((f) => ({ ...f }));
  }

  attemptsHistory(): VoiceV22ReconnectAttempt[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  stats(): VoiceV22RecoveryStats {
    const mean = this.rtts.length === 0 ? 0 : round2V22(this.rtts.reduce((s, x) => s + x, 0) / this.rtts.length);
    return {
      phase: this.phase,
      heartbeats: this.heartbeats,
      lateBeats: this.lateBeats,
      missedBeats: this.missedBeats,
      disconnects: this.disconnects,
      reconnectAttempts: this.attempts.length,
      reconnectSuccesses: this.attempts.filter((a) => a.outcome === 'success').length,
      recoveries: this.recoveries,
      gaveUp: this.gaveUp,
      meanRttMs: mean,
      maxRttMs: this.rtts.length === 0 ? 0 : Math.max(...this.rtts),
      degradationSteps: [...this.degradationSteps],
    };
  }

  summary(): string {
    const s = this.stats();
    return `recovery v22: phase=${s.phase}, heartbeats=${s.heartbeats} (${s.lateBeats} late, ${s.missedBeats} missed), ` +
      `disconnects=${s.disconnects}, reconnects=${s.reconnectAttempts} (${s.reconnectSuccesses} ok), ` +
      `recoveries=${s.recoveries}, mean rtt ${s.meanRttMs} ms`;
  }
}

export function createRecoveryEngineV22(
  sessionId: string,
  opts: Partial<VoiceV22RecoveryOptions> = {},
  sink?: VoiceV22EventSink,
): RecoveryEngineV22 {
  return new RecoveryEngineV22(sessionId, opts, sink);
}

/** Mock transport: scripted heartbeat outcomes for tests and the tools layer. */
export interface VoiceV22MockTransportOptions {
  /** RTTs to report, in order (repeats the last value). */
  rttsMs: number[];
  /** Beat indexes (0-based) that fail. */
  failAt: number[];
  /** Beat indexes that never arrive (missed). */
  missAt: number[];
}

export function defaultMockTransportV22Options(): VoiceV22MockTransportOptions {
  return { rttsMs: [120], failAt: [], missAt: [] };
}

export class MockTransportV22 {
  private readonly opts: VoiceV22MockTransportOptions;
  private beatIndex = 0;

  constructor(opts: Partial<VoiceV22MockTransportOptions> = {}) {
    this.opts = { ...defaultMockTransportV22Options(), ...opts };
  }

  /** Produce the next heartbeat at `atMs`. */
  beat(atMs: number): VoiceV22Heartbeat {
    const idx = this.beatIndex;
    this.beatIndex += 1;
    if (this.opts.missAt.includes(idx)) {
      return { atMs, rttMs: 0, ok: false };
    }
    const rttMs = this.opts.rttsMs[Math.min(idx, this.opts.rttsMs.length - 1)];
    return { atMs, rttMs, ok: !this.opts.failAt.includes(idx) };
  }

  beatsSent(): number {
    return this.beatIndex;
  }

  reset(): void {
    this.beatIndex = 0;
  }
}
