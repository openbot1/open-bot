/**
 * Provider health tracking for voice v24 (v1.37, Team T5).
 *
 * The catalogue knows the *latest* probe; this tracker knows
 * the *history*. The picker shows a provider as online the
 * moment one probe succeeds, but a provider that flaps —
 * up, down, up, down — should not be trusted the same way
 * as one that has been up all day. The health score makes
 * that visible:
 *
 *   score = 50 * successRate + 30 * latencyScore + 20 * stability
 *
 *   - successRate: share of probes in the window that succeeded;
 *   - latencyScore: 1 when the mean successful latency is at or
 *     below the good threshold, falling linearly to 0 at the
 *     bad threshold;
 *   - stability: 1 minus the share of probes that changed the
 *     outcome vs the previous probe (a flap costs stability).
 *
 * Grades: A >= 90, B >= 75, C >= 60, D >= 40, else F. A
 * provider is `degraded` when its score is below the degraded
 * threshold (default 60) or its consecutive failures reach
 * the failure threshold (default 3). Scores are computed
 * from recorded probes only — no probe history means "no
 * data", never a made-up score.
 *
 * All probes are host-measured and passed in; nothing here
 * dials a provider.
 */
import {
  clampV24,
  meanV24,
  round2V24,
  type VoiceV24ProbeObservation,
} from './types';

export type VoiceV24HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ProviderHealthV24Options {
  /** Probes older than this fall out of the window (default 3600000 ms = 1h). */
  windowMs: number;
  /** Mean latency at or below this scores full latency points (default 500 ms). */
  goodLatencyMs: number;
  /** Mean latency at or above this scores zero latency points (default 3000 ms). */
  badLatencyMs: number;
  /** Score below this marks the provider degraded (default 60). */
  degradedBelow: number;
  /** Consecutive failures at/above this mark the provider degraded (default 3). */
  degradedFailures: number;
  /** Max probes kept per provider (default 200). */
  maxProbesPerProvider: number;
}

export function defaultProviderHealthV24Options(): ProviderHealthV24Options {
  return {
    windowMs: 3600000,
    goodLatencyMs: 500,
    badLatencyMs: 3000,
    degradedBelow: 60,
    degradedFailures: 3,
    maxProbesPerProvider: 200,
  };
}

export function validateProviderHealthV24Options(
  o: Partial<ProviderHealthV24Options>,
): string[] {
  const errors: string[] = [];
  if (o.windowMs !== undefined && !(o.windowMs > 0 && o.windowMs <= 86400000)) {
    errors.push('windowMs must be > 0 and <= 86400000');
  }
  if (o.goodLatencyMs !== undefined && !(o.goodLatencyMs > 0 && o.goodLatencyMs <= 60000)) {
    errors.push('goodLatencyMs must be > 0 and <= 60000');
  }
  if (o.badLatencyMs !== undefined && !(o.badLatencyMs > 0 && o.badLatencyMs <= 120000)) {
    errors.push('badLatencyMs must be > 0 and <= 120000');
  }
  if (
    o.goodLatencyMs !== undefined &&
    o.badLatencyMs !== undefined &&
    o.badLatencyMs <= o.goodLatencyMs
  ) {
    errors.push('badLatencyMs must be greater than goodLatencyMs');
  }
  if (o.degradedBelow !== undefined && !(o.degradedBelow >= 0 && o.degradedBelow <= 100)) {
    errors.push('degradedBelow must be 0..100');
  }
  if (o.degradedFailures !== undefined && (!Number.isInteger(o.degradedFailures) || o.degradedFailures < 1 || o.degradedFailures > 20)) {
    errors.push('degradedFailures must be an integer 1..20');
  }
  if (o.maxProbesPerProvider !== undefined && (!Number.isInteger(o.maxProbesPerProvider) || o.maxProbesPerProvider < 10 || o.maxProbesPerProvider > 10000)) {
    errors.push('maxProbesPerProvider must be an integer 10..10000');
  }
  return errors;
}

/** Health score of one provider over the current window. */
export interface VoiceV24ProviderHealth {
  providerId: string;
  probes: number;
  successes: number;
  failures: number;
  successRate: number;
  meanLatencyMs: number;
  consecutiveFailures: number;
  /** Share of probes that flipped the outcome vs the previous probe. */
  flapRate: number;
  score: number;
  grade: VoiceV24HealthGrade;
  degraded: boolean;
  /** Null when the provider has no probes in the window. */
  hasData: boolean;
  windowStartMs: number;
  windowEndMs: number;
}

export function healthGradeV24(score: number): VoiceV24HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function createProviderHealthTrackerV24(
  opts: Partial<ProviderHealthV24Options> = {},
): ProviderHealthTrackerV24 {
  return new ProviderHealthTrackerV24(opts);
}

export class ProviderHealthTrackerV24 {
  private readonly opts: ProviderHealthV24Options;
  private readonly history = new Map<string, VoiceV24ProbeObservation[]>();

  constructor(opts: Partial<ProviderHealthV24Options> = {}) {
    const errors = validateProviderHealthV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ProviderHealthTrackerV24 options: ${errors.join('; ')}`);
    }
    const merged = { ...defaultProviderHealthV24Options(), ...opts };
    if (merged.badLatencyMs <= merged.goodLatencyMs) {
      throw new Error('Invalid ProviderHealthTrackerV24 options: badLatencyMs must be greater than goodLatencyMs');
    }
    this.opts = merged;
  }

  options(): ProviderHealthV24Options {
    return { ...this.opts };
  }

  /** Record one host-measured probe observation. */
  record(observation: VoiceV24ProbeObservation): void {
    if (typeof observation.providerId !== 'string' || observation.providerId.length === 0) {
      throw new Error('providerId must be a non-empty string');
    }
    if (!Number.isFinite(observation.atMs) || observation.atMs < 0) {
      throw new Error('atMs must be a finite number >= 0');
    }
    if (!(observation.latencyMs >= 0 && Number.isFinite(observation.latencyMs))) {
      throw new Error('latencyMs must be >= 0');
    }
    const list = this.history.get(observation.providerId) ?? [];
    list.push({ ...observation });
    list.sort((a, b) => a.atMs - b.atMs);
    while (list.length > this.opts.maxProbesPerProvider) list.shift();
    this.history.set(observation.providerId, list);
  }

  /** Record many observations at once (bulk import from a probe run). */
  recordMany(observations: readonly VoiceV24ProbeObservation[]): void {
    for (const observation of observations) this.record(observation);
  }

  probeCount(providerId: string): number {
    return this.history.get(providerId)?.length ?? 0;
  }

  providerIds(): string[] {
    return [...this.history.keys()].sort();
  }

  /** Consecutive failures at the end of the history (0 when the last probe succeeded). */
  consecutiveFailures(providerId: string): number {
    const list = this.history.get(providerId) ?? [];
    let n = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].ok) break;
      n += 1;
    }
    return n;
  }

  /** Success rate over the window ending at `nowMs` (null when no probes). */
  uptime(providerId: string, nowMs: number): number | null {
    const window = this.windowed(providerId, nowMs);
    if (window.length === 0) return null;
    const successes = window.filter((p) => p.ok).length;
    return round2V24(successes / window.length);
  }

  private windowed(providerId: string, nowMs: number): VoiceV24ProbeObservation[] {
    const list = this.history.get(providerId) ?? [];
    const start = nowMs - this.opts.windowMs;
    return list.filter((p) => p.atMs >= start && p.atMs <= nowMs);
  }

  /** Full health score for one provider over the window ending at `nowMs`. */
  score(providerId: string, nowMs: number): VoiceV24ProviderHealth {
    const window = this.windowed(providerId, nowMs);
    const windowStartMs = nowMs - this.opts.windowMs;
    const base: VoiceV24ProviderHealth = {
      providerId,
      probes: window.length,
      successes: 0,
      failures: 0,
      successRate: 0,
      meanLatencyMs: 0,
      consecutiveFailures: this.consecutiveFailures(providerId),
      flapRate: 0,
      score: 0,
      grade: 'F',
      degraded: false,
      hasData: window.length > 0,
      windowStartMs,
      windowEndMs: nowMs,
    };
    if (window.length === 0) return base;
    const successes = window.filter((p) => p.ok);
    base.successes = successes.length;
    base.failures = window.length - successes.length;
    base.successRate = round2V24(successes.length / window.length);
    const latencies = successes.map((p) => p.latencyMs);
    base.meanLatencyMs = round2V24(meanV24(latencies));
    let flips = 0;
    for (let i = 1; i < window.length; i += 1) {
      if (window[i].ok !== window[i - 1].ok) flips += 1;
    }
    base.flapRate = window.length <= 1 ? 0 : round2V24(flips / (window.length - 1));
    const latencyScore =
      base.meanLatencyMs <= this.opts.goodLatencyMs
        ? 1
        : base.meanLatencyMs >= this.opts.badLatencyMs
          ? 0
          : 1 -
            (base.meanLatencyMs - this.opts.goodLatencyMs) /
              (this.opts.badLatencyMs - this.opts.goodLatencyMs);
    const stability = 1 - base.flapRate;
    const raw =
      50 * base.successRate + 30 * clampV24(latencyScore, 0, 1) + 20 * clampV24(stability, 0, 1);
    base.score = round2V24(raw);
    base.grade = healthGradeV24(base.score);
    base.degraded =
      base.score < this.opts.degradedBelow ||
      base.consecutiveFailures >= this.opts.degradedFailures;
    return base;
  }

  /** Health scores for every provider with history, worst first. */
  allScores(nowMs: number): VoiceV24ProviderHealth[] {
    return this.providerIds()
      .map((id) => this.score(id, nowMs))
      .sort((a, b) => a.score - b.score || a.providerId.localeCompare(b.providerId));
  }

  /** Providers currently degraded (score or consecutive failures). */
  degradedProviders(nowMs: number): VoiceV24ProviderHealth[] {
    return this.allScores(nowMs).filter((h) => h.hasData && h.degraded);
  }

  /** Mean score across providers that have data (null when none do). */
  meanScore(nowMs: number): number | null {
    const scored = this.allScores(nowMs).filter((h) => h.hasData);
    if (scored.length === 0) return null;
    return round2V24(meanV24(scored.map((h) => h.score)));
  }

  /** Drop probes older than the window (keeps the map small on long runs). */
  prune(nowMs: number): number {
    let dropped = 0;
    const start = nowMs - this.opts.windowMs;
    for (const [id, list] of this.history) {
      const kept = list.filter((p) => p.atMs >= start);
      dropped += list.length - kept.length;
      if (kept.length === 0) this.history.delete(id);
      else this.history.set(id, kept);
    }
    return dropped;
  }

  reset(providerId?: string): void {
    if (providerId === undefined) this.history.clear();
    else this.history.delete(providerId);
  }

  summary(nowMs: number): string {
    const scores = this.allScores(nowMs);
    const withData = scores.filter((h) => h.hasData);
    if (withData.length === 0) return 'No provider probe history yet.';
    const degraded = withData.filter((h) => h.degraded).length;
    const mean = this.meanScore(nowMs);
    return (
      `${withData.length} providers with probe history, mean health ${mean}, ` +
      `${degraded} degraded, worst: ${withData[0].providerId} (${withData[0].score}, grade ${withData[0].grade}).`
    );
  }

  markdown(nowMs: number): string {
    const lines: string[] = ['# Voice v24 provider health', '', this.summary(nowMs), ''];
    lines.push('| Provider | Probes | Success | Mean latency | Flaps | Score | Grade | Degraded |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const h of this.allScores(nowMs)) {
      lines.push(
        `| ${h.providerId} | ${h.probes} | ${(h.successRate * 100).toFixed(0)}% | ${h.meanLatencyMs}ms | ${(h.flapRate * 100).toFixed(0)}% | ${h.score} | ${h.grade} | ${h.degraded ? 'yes' : 'no'} |`,
      );
    }
    return lines.join('\n');
  }
}
