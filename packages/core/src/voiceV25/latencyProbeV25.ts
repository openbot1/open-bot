/**
 * Real per-provider voice latency for voice v25 (v1.38, Team T5).
 *
 * v24 measures *health* — probes ok/fail, a score, a grade —
 * and its fallback chains switch on *usability* (a provider
 * is online or it is not). v25 measures *how slow*: every
 * voice turn the host reports carries three latencies —
 *
 *   - TTFT: ms to the first token (the LLM thinking),
 *   - first-audio: ms to the first audio frame (the TTS
 *     starting to speak),
 *   - total: ms for the whole turn —
 *
 * and the tracker keeps rolling statistics per provider
 * (mean / p50 / p95 per kind, consecutive slow turns,
 * consecutive failures). When a provider's p95 total crosses
 * the slow threshold for N consecutive turns, or it fails N
 * turns in a row, the tracker recommends a fallback: the
 * fastest healthy provider from the candidate list, with a
 * cooldown per session so the session does not flap between
 * providers on every slow turn.
 *
 * Samples are caller-supplied measurements (the host measured
 * them on real turns, or a mock harness supplied them). This
 * module never dials a provider, never reads a key, and never
 * invents a sample: a provider with no samples has no stats,
 * never a made-up p95.
 */
import {
  clampV25,
  formatDurationV25,
  isValidVoiceV25Id,
  meanV25,
  percentileV25,
  round2V25,
  VOICE_V25_CONSECUTIVE_FAILURES_DEFAULT,
  VOICE_V25_CONSECUTIVE_SLOW_DEFAULT,
  VOICE_V25_FALLBACK_COOLDOWN_DEFAULT_MS,
  VOICE_V25_LATENCY_P95_WINDOW,
  VOICE_V25_LATENCY_SLOW_DEFAULT_MS,
  type VoiceV25LatencyFallbackDecision,
  type VoiceV25LatencySample,
  type VoiceV25LatencyStats,
} from './types';

export interface ProviderLatencyV25Options {
  /** Total latency past this counts as a slow turn (default 3000). */
  slowThresholdMs: number;
  /** Consecutive slow turns before a provider is `slow` (default 3). */
  consecutiveSlow: number;
  /** Consecutive failed turns before a provider is `failing` (default 3). */
  consecutiveFailures: number;
  /** Samples kept per provider for the rolling stats (default 20). */
  windowSamples: number;
  /** Min ms between two fallback switches in one session (default 30000). */
  fallbackCooldownMs: number;
  /** Max samples kept per provider (oldest dropped, default 1000). */
  maxSamples: number;
}

export function defaultProviderLatencyV25Options(): ProviderLatencyV25Options {
  return {
    slowThresholdMs: VOICE_V25_LATENCY_SLOW_DEFAULT_MS,
    consecutiveSlow: VOICE_V25_CONSECUTIVE_SLOW_DEFAULT,
    consecutiveFailures: VOICE_V25_CONSECUTIVE_FAILURES_DEFAULT,
    windowSamples: VOICE_V25_LATENCY_P95_WINDOW,
    fallbackCooldownMs: VOICE_V25_FALLBACK_COOLDOWN_DEFAULT_MS,
    maxSamples: 1000,
  };
}

export function validateProviderLatencyV25Options(
  o: Partial<ProviderLatencyV25Options>,
): string[] {
  const errors: string[] = [];
  if (o.slowThresholdMs !== undefined && !(o.slowThresholdMs >= 100 && o.slowThresholdMs <= 60000)) {
    errors.push('slowThresholdMs must be 100..60000');
  }
  if (o.consecutiveSlow !== undefined && (!Number.isInteger(o.consecutiveSlow) || o.consecutiveSlow < 1 || o.consecutiveSlow > 20)) {
    errors.push('consecutiveSlow must be an integer 1..20');
  }
  if (o.consecutiveFailures !== undefined && (!Number.isInteger(o.consecutiveFailures) || o.consecutiveFailures < 1 || o.consecutiveFailures > 20)) {
    errors.push('consecutiveFailures must be an integer 1..20');
  }
  if (o.windowSamples !== undefined && (!Number.isInteger(o.windowSamples) || o.windowSamples < 3 || o.windowSamples > 500)) {
    errors.push('windowSamples must be an integer 3..500');
  }
  if (o.fallbackCooldownMs !== undefined && !(o.fallbackCooldownMs >= 0 && o.fallbackCooldownMs <= 600000)) {
    errors.push('fallbackCooldownMs must be 0..600000');
  }
  if (o.maxSamples !== undefined && (!Number.isInteger(o.maxSamples) || o.maxSamples < 10 || o.maxSamples > 100000)) {
    errors.push('maxSamples must be an integer 10..100000');
  }
  return errors;
}

/** One provider in the ranking: p95 total + health flags. */
export interface VoiceV25ProviderLatencyRank {
  providerId: string;
  p95TotalMs: number;
  meanTotalMs: number;
  samples: number;
  isSlow: boolean;
  isFailing: boolean;
  /** Null when the provider has no total samples yet. */
  hasData: boolean;
}

export function createProviderLatencyTrackerV25(
  opts: Partial<ProviderLatencyV25Options> = {},
): ProviderLatencyTrackerV25 {
  return new ProviderLatencyTrackerV25(opts);
}

export class ProviderLatencyTrackerV25 {
  private readonly opts: ProviderLatencyV25Options;
  private readonly samples = new Map<string, VoiceV25LatencySample[]>();
  private readonly decisions: VoiceV25LatencyFallbackDecision[] = [];
  private readonly lastSwitchAtMs = new Map<string, number>();
  private decisionSeq = 0;

  constructor(opts: Partial<ProviderLatencyV25Options> = {}) {
    const errors = validateProviderLatencyV25Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ProviderLatencyTrackerV25 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultProviderLatencyV25Options(), ...opts };
  }

  options(): ProviderLatencyV25Options {
    return { ...this.opts };
  }

  /** Record one host-measured latency sample. Returns the stored sample. */
  record(sample: {
    providerId: string;
    model: string;
    sessionId: string;
    turnId?: string | null;
    atMs: number;
    ttftMs?: number | null;
    firstAudioMs?: number | null;
    totalMs?: number | null;
    ok: boolean;
    error?: string;
  }): VoiceV25LatencySample {
    if (!isValidVoiceV25Id(sample.providerId)) throw new Error(`Invalid providerId "${sample.providerId}"`);
    if (typeof sample.model !== 'string' || sample.model.length === 0) {
      throw new Error('model must be a non-empty string');
    }
    if (!isValidVoiceV25Id(sample.sessionId)) throw new Error(`Invalid sessionId "${sample.sessionId}"`);
    if (!Number.isFinite(sample.atMs) || sample.atMs < 0) throw new Error('atMs must be a finite number >= 0');
    for (const [name, value] of [
      ['ttftMs', sample.ttftMs],
      ['firstAudioMs', sample.firstAudioMs],
      ['totalMs', sample.totalMs],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${name} must be a finite number >= 0 or null`);
      }
    }
    if (
      (sample.ttftMs === undefined || sample.ttftMs === null) &&
      (sample.firstAudioMs === undefined || sample.firstAudioMs === null) &&
      (sample.totalMs === undefined || sample.totalMs === null) &&
      sample.ok
    ) {
      throw new Error('At least one of ttftMs, firstAudioMs, totalMs must be measured (a failed turn may report none)');
    }
    const stored: VoiceV25LatencySample = {
      providerId: sample.providerId,
      model: sample.model,
      sessionId: sample.sessionId,
      turnId: sample.turnId ?? null,
      atMs: sample.atMs,
      ttftMs: sample.ttftMs ?? null,
      firstAudioMs: sample.firstAudioMs ?? null,
      totalMs: sample.totalMs ?? null,
      ok: sample.ok,
      error: sample.error,
    };
    const list = this.samples.get(sample.providerId) ?? [];
    list.push(stored);
    while (list.length > this.opts.maxSamples) list.shift();
    this.samples.set(sample.providerId, list);
    return { ...stored };
  }

  providerIds(): string[] {
    return [...this.samples.keys()];
  }

  samplesFor(providerId: string, sessionId?: string): VoiceV25LatencySample[] {
    const list = this.samples.get(providerId) ?? [];
    return list
      .filter((s) => sessionId === undefined || s.sessionId === sessionId)
      .map((s) => ({ ...s }));
  }

  /** Rolling statistics for one provider (null when it has no samples). */
  stats(providerId: string, sessionId?: string): VoiceV25LatencyStats | null {
    const all = this.samplesFor(providerId, sessionId);
    if (all.length === 0) return null;
    const window = all.slice(-this.opts.windowSamples);
    const pick = (kind: 'ttftMs' | 'firstAudioMs' | 'totalMs'): number[] =>
      window.map((s) => s[kind]).filter((v): v is number => v !== null);
    const ttft = pick('ttftMs');
    const firstAudio = pick('firstAudioMs');
    const total = pick('totalMs');
    // Consecutive slow / failed turns from the tail: a failure
    // resets the slow streak and vice versa, so walk once and
    // stop at the first turn that breaks the streak.
    let consecutiveSlow = 0;
    let consecutiveFailures = 0;
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const s = window[i];
      if (!s.ok) {
        if (consecutiveSlow > 0) break;
        consecutiveFailures += 1;
        continue;
      }
      if (consecutiveFailures > 0) break;
      if (s.totalMs !== null && s.totalMs >= this.opts.slowThresholdMs) {
        consecutiveSlow += 1;
      } else {
        break;
      }
    }
    const p95Total = percentileV25(total, 95);
    const isSlow = consecutiveSlow >= this.opts.consecutiveSlow || (total.length >= 3 && p95Total >= this.opts.slowThresholdMs);
    const isFailing = consecutiveFailures >= this.opts.consecutiveFailures;
    return {
      providerId,
      samples: window.length,
      okSamples: window.filter((s) => s.ok).length,
      failedSamples: window.filter((s) => !s.ok).length,
      ttftMeanMs: round2V25(meanV25(ttft)),
      ttftP50Ms: round2V25(percentileV25(ttft, 50)),
      ttftP95Ms: round2V25(percentileV25(ttft, 95)),
      firstAudioMeanMs: round2V25(meanV25(firstAudio)),
      firstAudioP50Ms: round2V25(percentileV25(firstAudio, 50)),
      firstAudioP95Ms: round2V25(percentileV25(firstAudio, 95)),
      totalMeanMs: round2V25(meanV25(total)),
      totalP50Ms: round2V25(percentileV25(total, 50)),
      totalP95Ms: round2V25(p95Total),
      totalMaxMs: total.length === 0 ? 0 : Math.max(...total),
      consecutiveSlow,
      consecutiveFailures,
      isSlow,
      isFailing,
      lastAtMs: window.length === 0 ? null : window[window.length - 1].atMs,
    };
  }

  /** All providers with stats, slowest p95 first. */
  allStats(sessionId?: string): VoiceV25LatencyStats[] {
    const out: VoiceV25LatencyStats[] = [];
    for (const providerId of this.providerIds()) {
      const s = this.stats(providerId, sessionId);
      if (s !== null) out.push(s);
    }
    return out.sort((a, b) => b.totalP95Ms - a.totalP95Ms);
  }

  /** Providers ranked fastest-first by p95 total (no-data providers last). */
  rankProviders(sessionId?: string): VoiceV25ProviderLatencyRank[] {
    const ranks: VoiceV25ProviderLatencyRank[] = [];
    for (const providerId of this.providerIds()) {
      const s = this.stats(providerId, sessionId);
      if (s === null) continue;
      ranks.push({
        providerId,
        p95TotalMs: s.totalP95Ms,
        meanTotalMs: s.totalMeanMs,
        samples: s.samples,
        isSlow: s.isSlow,
        isFailing: s.isFailing,
        hasData: s.totalP95Ms > 0 || s.totalMeanMs > 0,
      });
    }
    return ranks.sort((a, b) => {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      return a.p95TotalMs - b.p95TotalMs;
    });
  }

  /**
   * Decide whether the session should leave `currentProviderId`
   * for a faster candidate. Returns a decision even when the
   * answer is "stay" (`toProviderId: null`, `switched: false`)
   * so the caller can log the reasoning. A switch is refused
   * while the session is inside its cooldown, and no candidate
   * that is slow/failing (or has no data) is ever picked.
   */
  recommendFallback(
    sessionId: string,
    currentProviderId: string,
    candidateProviderIds: readonly string[],
    atMs: number,
  ): VoiceV25LatencyFallbackDecision {
    if (!isValidVoiceV25Id(sessionId)) throw new Error(`Invalid sessionId "${sessionId}"`);
    if (!isValidVoiceV25Id(currentProviderId)) throw new Error(`Invalid currentProviderId "${currentProviderId}"`);
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    const current = this.stats(currentProviderId, sessionId);
    this.decisionSeq += 1;
    const base = {
      id: `fb-${this.decisionSeq}`,
      sessionId,
      fromProviderId: currentProviderId,
      atMs,
    };
    const recordDecision = (
      toProviderId: string | null,
      reason: VoiceV25LatencyFallbackDecision['reason'],
      triggerP95Ms: number,
      thresholdMs: number,
      switched: boolean,
    ): VoiceV25LatencyFallbackDecision => {
      const decision: VoiceV25LatencyFallbackDecision = {
        ...base,
        toProviderId,
        reason,
        triggerP95Ms,
        thresholdMs,
        switched,
      };
      this.decisions.push(decision);
      if (switched) this.lastSwitchAtMs.set(sessionId, atMs);
      return { ...decision };
    };
    if (current === null) {
      return recordDecision(null, 'no-candidate', 0, this.opts.slowThresholdMs, false);
    }
    const needsSwitch = current.isSlow || current.isFailing;
    if (!needsSwitch) {
      return recordDecision(null, 'no-candidate', current.totalP95Ms, this.opts.slowThresholdMs, false);
    }
    const lastSwitch = this.lastSwitchAtMs.get(sessionId);
    if (lastSwitch !== undefined && atMs - lastSwitch < this.opts.fallbackCooldownMs) {
      return recordDecision(null, current.isFailing ? 'failing' : 'slow', current.totalP95Ms, this.opts.slowThresholdMs, false);
    }
    const ranked = this.rankProviders(sessionId).filter(
      (r) => r.providerId !== currentProviderId && !r.isSlow && !r.isFailing && r.hasData,
    );
    // Candidates the caller listed win over merely-measured ones.
    const listed = ranked.filter((r) => candidateProviderIds.includes(r.providerId));
    const pick = listed.length > 0 ? listed[0] : ranked[0] ?? null;
    if (pick === null) {
      return recordDecision(null, current.isFailing ? 'failing' : 'slow', current.totalP95Ms, this.opts.slowThresholdMs, false);
    }
    return recordDecision(
      pick.providerId,
      current.isFailing ? 'failing' : 'slow',
      current.totalP95Ms,
      this.opts.slowThresholdMs,
      true,
    );
  }

  /** Fallback decisions for a session (newest last). */
  decisionsFor(sessionId: string): VoiceV25LatencyFallbackDecision[] {
    return this.decisions.filter((d) => d.sessionId === sessionId).map((d) => ({ ...d }));
  }

  /** Drop samples older than `olderThanMs` before `atMs`. Returns dropped count. */
  prune(atMs: number, olderThanMs: number): number {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    if (!(olderThanMs > 0)) throw new Error('olderThanMs must be > 0');
    const cutoff = atMs - olderThanMs;
    let dropped = 0;
    for (const [providerId, list] of this.samples) {
      const kept = list.filter((s) => s.atMs >= cutoff);
      dropped += list.length - kept.length;
      this.samples.set(providerId, kept);
    }
    return dropped;
  }

  count(): number {
    let n = 0;
    for (const list of this.samples.values()) n += list.length;
    return n;
  }

  reset(): void {
    this.samples.clear();
    this.decisions.length = 0;
    this.lastSwitchAtMs.clear();
    this.decisionSeq = 0;
  }

  summary(sessionId?: string): string {
    const stats = this.allStats(sessionId);
    if (stats.length === 0) return 'No latency samples yet.';
    const parts = stats.map(
      (s) =>
        `${s.providerId}: p50 ${formatDurationV25(s.totalP50Ms)}, p95 ${formatDurationV25(s.totalP95Ms)}` +
        `${s.isSlow ? ' (SLOW)' : ''}${s.isFailing ? ' (FAILING)' : ''}`,
    );
    return parts.join(' · ');
  }

  markdown(sessionId?: string): string {
    const stats = this.allStats(sessionId);
    const lines: string[] = ['# Voice v25 provider latency', ''];
    if (stats.length === 0) {
      lines.push('No latency samples yet — record host-measured turn latencies first.');
      return lines.join('\n');
    }
    lines.push(`Slow threshold: ${formatDurationV25(this.opts.slowThresholdMs)}; cooldown: ${formatDurationV25(this.opts.fallbackCooldownMs)}.`);
    lines.push('', '| Provider | Samples | TTFT p95 | First-audio p95 | Total p50 | Total p95 | Max | Slow × | Fail × | State |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const s of stats) {
      const state = s.isFailing ? 'failing' : s.isSlow ? 'slow' : 'healthy';
      lines.push(
        `| ${s.providerId} | ${s.samples} | ${formatDurationV25(s.ttftP95Ms)} | ${formatDurationV25(s.firstAudioP95Ms)} | ` +
        `${formatDurationV25(s.totalP50Ms)} | ${formatDurationV25(s.totalP95Ms)} | ${formatDurationV25(s.totalMaxMs)} | ` +
        `${s.consecutiveSlow} | ${s.consecutiveFailures} | ${state} |`,
      );
    }
    const decisions = sessionId === undefined
      ? this.decisions
      : this.decisions.filter((d) => d.sessionId === sessionId);
    if (decisions.length > 0) {
      lines.push('', '## Fallback decisions');
      for (const d of decisions) {
        lines.push(
          `- ${d.atMs}ms: ${d.fromProviderId} → ${d.toProviderId ?? '(stay)'} (${d.reason}, ` +
          `p95 ${formatDurationV25(d.triggerP95Ms)} vs threshold ${formatDurationV25(d.thresholdMs)}${d.switched ? ', switched' : ', stayed'})`,
        );
      }
    }
    return lines.join('\n');
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV25 };
