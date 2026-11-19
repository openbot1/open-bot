/**
 * End-to-end latency budget for voice v26 (v1.39, Team T5).
 *
 * v25 measures real per-provider voice latency (TTFT, first
 * audio, turn total, rolling p50/p95) and falls back to a faster
 * provider when a threshold breaks. v26 owns the *budget* those
 * measurements are judged against: one budget per stage
 * (STT -> model -> TTS) plus a total budget, per turn, with
 * breach alerts and a degraded mode that trades quality for
 * latency when the budget keeps breaking.
 *
 * Budget profiles:
 *   - realtime: STT 400ms + model 800ms + TTS 600ms = 1800ms total
 *   - balanced: 800 + 2000 + 1200 = 4000ms total
 *   - quality:  1500 + 5000 + 2500 = 9000ms total
 * A caller may override any stage budget.
 *
 * Degraded mode:
 *   - `light` after N consecutive breaching turns (default 3):
 *     cap reply length, prefer the fastest voice, skip prosody
 *     and the eval pass;
 *   - `heavy` after N more consecutive breaches: also use the
 *     lighter STT model and a shorter reply cap;
 *   - recovery: after N consecutive clean turns (default 5)
 *     the level steps back down, one level at a time, until
 *     `off`. Degraded mode never changes a budget — it changes
 *     what the pipeline does to *meet* the budget.
 *
 * Samples are caller-supplied measurements (the host reports
 * real STT/model/TTS timings). All clocks virtual.
 */
import {
  VOICE_V26_BUDGET_PROFILES,
  VOICE_V26_CONSECUTIVE_BREACHES_DEFAULT,
  VOICE_V26_CONSECUTIVE_CLEAN_DEFAULT,
  VOICE_V26_DEGRADED_POLICIES,
  VOICE_V26_LATENCY_P95_WINDOW,
  VOICE_V26_MAX_SAMPLES_DEFAULT,
  meanV26,
  percentileV26,
  round2V26,
  type VoiceV26BudgetBreach,
  type VoiceV26BudgetProfile,
  type VoiceV26DegradedEvent,
  type VoiceV26DegradedLevel,
  type VoiceV26DegradedPolicy,
  type VoiceV26LatencySample,
  type VoiceV26LatencyStage,
  type VoiceV26StageBudgets,
  type VoiceV26StageStats,
} from './types';

export interface LatencyBudgetV26Options {
  /** Budget profile (default 'balanced'). */
  profile: VoiceV26BudgetProfile;
  /** Per-stage budget overrides (ms). */
  budgets: Partial<VoiceV26StageBudgets>;
  /** Consecutive breaching turns before escalating (default 3). */
  consecutiveBreachesToEscalate: number;
  /** Consecutive clean turns before stepping down (default 5). */
  consecutiveCleanToRecover: number;
  /** Rolling window for p50/p95 (default 100). */
  window: number;
  /** Max samples kept (default 5000). */
  maxSamples: number;
}

export function defaultLatencyBudgetV26Options(): LatencyBudgetV26Options {
  return {
    profile: 'balanced',
    budgets: {},
    consecutiveBreachesToEscalate: VOICE_V26_CONSECUTIVE_BREACHES_DEFAULT,
    consecutiveCleanToRecover: VOICE_V26_CONSECUTIVE_CLEAN_DEFAULT,
    window: VOICE_V26_LATENCY_P95_WINDOW,
    maxSamples: VOICE_V26_MAX_SAMPLES_DEFAULT,
  };
}

export function validateLatencyBudgetV26Options(o: Partial<LatencyBudgetV26Options>): string[] {
  const errors: string[] = [];
  if (o.profile !== undefined && o.profile !== 'realtime' && o.profile !== 'balanced' && o.profile !== 'quality') {
    errors.push('profile must be realtime | balanced | quality');
  }
  const budgets = o.budgets ?? {};
  for (const [key, value] of Object.entries(budgets)) {
    if (value !== undefined && !(value >= 50 && value <= 60000)) {
      errors.push(`budgets.${key} must be 50..60000`);
    }
  }
  if (
    o.consecutiveBreachesToEscalate !== undefined &&
    (!Number.isInteger(o.consecutiveBreachesToEscalate) || o.consecutiveBreachesToEscalate < 1 || o.consecutiveBreachesToEscalate > 20)
  ) {
    errors.push('consecutiveBreachesToEscalate must be an integer 1..20');
  }
  if (
    o.consecutiveCleanToRecover !== undefined &&
    (!Number.isInteger(o.consecutiveCleanToRecover) || o.consecutiveCleanToRecover < 1 || o.consecutiveCleanToRecover > 50)
  ) {
    errors.push('consecutiveCleanToRecover must be an integer 1..50');
  }
  if (o.window !== undefined && (!Number.isInteger(o.window) || o.window < 5 || o.window > 1000)) {
    errors.push('window must be an integer 5..1000');
  }
  if (o.maxSamples !== undefined && (!Number.isInteger(o.maxSamples) || o.maxSamples < 10 || o.maxSamples > 100000)) {
    errors.push('maxSamples must be an integer 10..100000');
  }
  return errors;
}

/** Per-turn latency roll-up (all four stages of one turn). */
export interface VoiceV26TurnLatency {
  sessionId: string;
  turnId: string | null;
  turnIndex: number | null;
  sttMs: number | null;
  modelMs: number | null;
  ttsMs: number | null;
  totalMs: number | null;
  /** Stages that breached their budget on this turn. */
  breachedStages: VoiceV26LatencyStage[];
  /** True when any stage (or the total) breached. */
  breached: boolean;
  degradedLevel: VoiceV26DegradedLevel;
  atMs: number;
}

/** Aggregate latency-budget statistics. */
export interface VoiceV26LatencyBudgetStats {
  sessionId: string;
  profile: VoiceV26BudgetProfile;
  budgets: VoiceV26StageBudgets;
  samples: number;
  turns: number;
  breachedTurns: number;
  breachRate: number;
  breaches: number;
  degradedLevel: VoiceV26DegradedLevel;
  consecutiveBreaches: number;
  consecutiveClean: number;
  stages: VoiceV26StageStats[];
}

export function createLatencyBudgetV26(
  sessionId: string,
  opts: Partial<LatencyBudgetV26Options> = {},
): LatencyBudgetV26 {
  return new LatencyBudgetV26(sessionId, opts);
}

export class LatencyBudgetV26 {
  private readonly sessionId: string;
  private readonly opts: LatencyBudgetV26Options;
  private readonly budgets: VoiceV26StageBudgets;
  private readonly samples: VoiceV26LatencySample[] = [];
  private readonly breaches: VoiceV26BudgetBreach[] = [];
  private readonly degradedEvents: VoiceV26DegradedEvent[] = [];
  private readonly turnLatencies: VoiceV26TurnLatency[] = [];
  private degradedLevel: VoiceV26DegradedLevel = 'off';
  private consecutiveBreaches = 0;
  private consecutiveClean = 0;
  private breachSeq = 0;

  constructor(sessionId: string, opts: Partial<LatencyBudgetV26Options> = {}) {
    const errors = validateLatencyBudgetV26Options(opts);
    if (errors.length > 0) throw new Error(`Invalid LatencyBudgetV26Options: ${errors.join('; ')}`);
    this.sessionId = sessionId;
    this.opts = { ...defaultLatencyBudgetV26Options(), ...opts };
    const profile = VOICE_V26_BUDGET_PROFILES[this.opts.profile];
    this.budgets = { ...profile, ...this.opts.budgets };
  }

  options(): LatencyBudgetV26Options {
    return { ...this.opts, budgets: { ...this.opts.budgets } };
  }

  profile(): VoiceV26BudgetProfile {
    return this.opts.profile;
  }

  budgetsNow(): VoiceV26StageBudgets {
    return { ...this.budgets };
  }

  degradedLevelNow(): VoiceV26DegradedLevel {
    return this.degradedLevel;
  }

  policyNow(): VoiceV26DegradedPolicy {
    return { ...VOICE_V26_DEGRADED_POLICIES[this.degradedLevel] };
  }

  /** Switch the budget profile (budgets change, history is kept). */
  setProfile(profile: VoiceV26BudgetProfile, atMs: number): VoiceV26StageBudgets {
    void atMs;
    const next = VOICE_V26_BUDGET_PROFILES[profile];
    this.opts.profile = profile;
    this.budgets.sttMs = next.sttMs;
    this.budgets.modelMs = next.modelMs;
    this.budgets.ttsMs = next.ttsMs;
    this.budgets.totalMs = next.totalMs;
    return this.budgetsNow();
  }

  /** Override one stage budget (ms). */
  setBudget(stage: VoiceV26LatencyStage, ms: number): VoiceV26StageBudgets {
    if (!(ms >= 50 && ms <= 60000)) throw new Error('budget must be 50..60000');
    if (stage === 'stt') this.budgets.sttMs = ms;
    if (stage === 'model') this.budgets.modelMs = ms;
    if (stage === 'tts') this.budgets.ttsMs = ms;
    if (stage === 'total') this.budgets.totalMs = ms;
    return this.budgetsNow();
  }

  /**
   * Record one measured stage latency. Returns the breach, if
   * the sample broke its stage budget.
   */
  recordStage(sample: {
    stage: VoiceV26LatencyStage;
    ms: number;
    turnId?: string | null;
    turnIndex?: number | null;
    providerId?: string | null;
    atMs: number;
  }): VoiceV26BudgetBreach | null {
    if (!(sample.ms >= 0 && Number.isFinite(sample.ms))) {
      throw new Error('latency ms must be a finite number >= 0');
    }
    const entry: VoiceV26LatencySample = {
      sessionId: this.sessionId,
      turnId: sample.turnId ?? null,
      turnIndex: sample.turnIndex ?? null,
      stage: sample.stage,
      ms: sample.ms,
      providerId: sample.providerId ?? null,
      atMs: sample.atMs,
    };
    this.samples.push(entry);
    if (this.samples.length > this.opts.maxSamples) this.samples.shift();
    const budgetMs = this.budgetFor(sample.stage);
    if (sample.ms <= budgetMs) return null;
    this.breachSeq += 1;
    const breach: VoiceV26BudgetBreach = {
      id: `br26-${this.breachSeq}`,
      sessionId: this.sessionId,
      turnId: entry.turnId,
      stage: sample.stage,
      ms: sample.ms,
      budgetMs,
      overMs: sample.ms - budgetMs,
      overPct: round2V26(((sample.ms - budgetMs) / budgetMs) * 100),
      atMs: sample.atMs,
      degradedLevel: this.degradedLevel,
    };
    this.breaches.push(breach);
    return breach;
  }

  /**
   * Record a whole turn (all stages at once) and drive the
   * degraded-mode state machine. Returns the turn roll-up.
   */
  recordTurn(input: {
    turnId?: string | null;
    turnIndex?: number | null;
    sttMs?: number | null;
    modelMs?: number | null;
    ttsMs?: number | null;
    providerId?: string | null;
    atMs: number;
  }): VoiceV26TurnLatency {
    const stages: Array<{ stage: VoiceV26LatencyStage; ms: number | null }> = [
      { stage: 'stt', ms: input.sttMs ?? null },
      { stage: 'model', ms: input.modelMs ?? null },
      { stage: 'tts', ms: input.ttsMs ?? null },
    ];
    const breachedStages: VoiceV26LatencyStage[] = [];
    let totalMs: number | null = null;
    let totalKnown = true;
    for (const s of stages) {
      if (s.ms === null) {
        totalKnown = false;
        continue;
      }
      const breach = this.recordStage({
        stage: s.stage,
        ms: s.ms,
        turnId: input.turnId ?? null,
        turnIndex: input.turnIndex ?? null,
        providerId: input.providerId ?? null,
        atMs: input.atMs,
      });
      if (breach) breachedStages.push(s.stage);
    }
    if (totalKnown) {
      totalMs = (input.sttMs ?? 0) + (input.modelMs ?? 0) + (input.ttsMs ?? 0);
      const breach = this.recordStage({
        stage: 'total',
        ms: totalMs,
        turnId: input.turnId ?? null,
        turnIndex: input.turnIndex ?? null,
        providerId: input.providerId ?? null,
        atMs: input.atMs,
      });
      if (breach) breachedStages.push('total');
    }
    const breached = breachedStages.length > 0;
    if (breached) {
      this.consecutiveBreaches += 1;
      this.consecutiveClean = 0;
      this.maybeEscalate(input.atMs);
    } else {
      this.consecutiveClean += 1;
      this.consecutiveBreaches = 0;
      this.maybeRecover(input.atMs);
    }
    const rollup: VoiceV26TurnLatency = {
      sessionId: this.sessionId,
      turnId: input.turnId ?? null,
      turnIndex: input.turnIndex ?? null,
      sttMs: input.sttMs ?? null,
      modelMs: input.modelMs ?? null,
      ttsMs: input.ttsMs ?? null,
      totalMs,
      breachedStages,
      breached,
      degradedLevel: this.degradedLevel,
      atMs: input.atMs,
    };
    this.turnLatencies.push(rollup);
    if (this.turnLatencies.length > this.opts.maxSamples) this.turnLatencies.shift();
    return rollup;
  }

  /** Rolling stats for one stage (windowed p50/p95). */
  stageStats(stage: VoiceV26LatencyStage): VoiceV26StageStats {
    const values = this.samples
      .filter((s) => s.stage === stage)
      .slice(-this.opts.window)
      .map((s) => s.ms);
    const budgetMs = this.budgetFor(stage);
    const stageBreaches = this.breaches.filter((b) => b.stage === stage).length;
    return {
      stage,
      samples: values.length,
      meanMs: values.length === 0 ? 0 : round2V26(meanV26(values)),
      p50Ms: values.length === 0 ? 0 : round2V26(percentileV26(values, 50)),
      p95Ms: values.length === 0 ? 0 : round2V26(percentileV26(values, 95)),
      maxMs: values.length === 0 ? 0 : Math.max(...values),
      budgetMs,
      breaches: stageBreaches,
      breachRate: values.length === 0 ? 0 : round2V26(stageBreaches / values.length),
    };
  }

  /** Stats for all four stages. */
  allStageStats(): VoiceV26StageStats[] {
    return (['stt', 'model', 'tts', 'total'] as VoiceV26LatencyStage[]).map((s) => this.stageStats(s));
  }

  /** Which stage is the current bottleneck (highest p95 / budget). */
  bottleneck(): VoiceV26StageStats | null {
    const stats = this.allStageStats().filter((s) => s.samples > 0);
    if (stats.length === 0) return null;
    let worst = stats[0];
    for (const s of stats) {
      const ratio = s.budgetMs === 0 ? 0 : s.p95Ms / s.budgetMs;
      const worstRatio = worst.budgetMs === 0 ? 0 : worst.p95Ms / worst.budgetMs;
      if (ratio > worstRatio) worst = s;
    }
    return worst;
  }

  breachesList(filter: { stage?: VoiceV26LatencyStage } = {}): VoiceV26BudgetBreach[] {
    return this.breaches
      .filter((b) => (filter.stage === undefined || b.stage === filter.stage))
      .map((b) => ({ ...b }));
  }

  degradedEventsList(): VoiceV26DegradedEvent[] {
    return this.degradedEvents.map((e) => ({ ...e }));
  }

  turnLatenciesList(): VoiceV26TurnLatency[] {
    return this.turnLatencies.map((t) => ({ ...t, breachedStages: [...t.breachedStages] }));
  }

  stats(): VoiceV26LatencyBudgetStats {
    const breachedTurns = this.turnLatencies.filter((t) => t.breached).length;
    return {
      sessionId: this.sessionId,
      profile: this.opts.profile,
      budgets: this.budgetsNow(),
      samples: this.samples.length,
      turns: this.turnLatencies.length,
      breachedTurns,
      breachRate: this.turnLatencies.length === 0 ? 0 : round2V26(breachedTurns / this.turnLatencies.length),
      breaches: this.breaches.length,
      degradedLevel: this.degradedLevel,
      consecutiveBreaches: this.consecutiveBreaches,
      consecutiveClean: this.consecutiveClean,
      stages: this.allStageStats(),
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.breaches.length = 0;
    this.degradedEvents.length = 0;
    this.turnLatencies.length = 0;
    this.degradedLevel = 'off';
    this.consecutiveBreaches = 0;
    this.consecutiveClean = 0;
    this.breachSeq = 0;
  }

  summary(): string {
    const s = this.stats();
    const bottleneck = this.bottleneck();
    return (
      `latency budget v26 ${this.sessionId} (${s.profile}): ` +
      `${s.turns} turns, ${s.breachedTurns} breached (${s.breachRate * 100}%), ` +
      `${s.breaches} stage breaches, degraded ${s.degradedLevel}` +
      (bottleneck ? `, bottleneck ${bottleneck.stage} p95 ${bottleneck.p95Ms}ms / ${bottleneck.budgetMs}ms` : '')
    );
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Latency budget v26',
      '',
      `Session: \`${this.sessionId}\` — profile \`${s.profile}\`, degraded \`${s.degradedLevel}\``,
      '',
      `- Turns: ${s.turns} — Breached turns: ${s.breachedTurns} (${round2V26(s.breachRate * 100)}%)`,
      `- Stage breaches: ${s.breaches}`,
      `- Consecutive breaches: ${s.consecutiveBreaches} — Consecutive clean: ${s.consecutiveClean}`,
      '',
      '| stage | budget ms | samples | mean ms | p50 ms | p95 ms | max ms | breaches |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const st of s.stages) {
      lines.push(
        `| ${st.stage} | ${st.budgetMs} | ${st.samples} | ${st.meanMs} | ` +
        `${st.p50Ms} | ${st.p95Ms} | ${st.maxMs} | ${st.breaches} |`,
      );
    }
    lines.push('', '## Degraded-mode events', '');
    if (this.degradedEvents.length === 0) {
      lines.push('None.');
    } else {
      for (const e of this.degradedEvents) {
        lines.push(`- ${e.atMs}ms: ${e.from} -> ${e.to} (${e.reason}, ${e.consecutiveBreaches} consecutive breaches)`);
      }
    }
    return lines.join('\n');
  }

  private budgetFor(stage: VoiceV26LatencyStage): number {
    if (stage === 'stt') return this.budgets.sttMs;
    if (stage === 'model') return this.budgets.modelMs;
    if (stage === 'tts') return this.budgets.ttsMs;
    return this.budgets.totalMs;
  }

  private maybeEscalate(atMs: number): void {
    if (this.consecutiveBreaches < this.opts.consecutiveBreachesToEscalate) return;
    if (this.degradedLevel === 'off') {
      this.setDegraded('light', atMs, 'consecutive budget breaches');
    } else if (this.degradedLevel === 'light') {
      this.setDegraded('heavy', atMs, 'consecutive budget breaches continue');
    }
  }

  private maybeRecover(atMs: number): void {
    if (this.consecutiveClean < this.opts.consecutiveCleanToRecover) return;
    if (this.degradedLevel === 'heavy') {
      this.setDegraded('light', atMs, 'turns running clean again');
    } else if (this.degradedLevel === 'light') {
      this.setDegraded('off', atMs, 'turns running clean again');
    }
  }

  private setDegraded(to: VoiceV26DegradedLevel, atMs: number, reason: string): void {
    const from = this.degradedLevel;
    if (from === to) return;
    const breachesAtChange = this.consecutiveBreaches;
    this.degradedLevel = to;
    this.consecutiveBreaches = 0;
    this.consecutiveClean = 0;
    this.degradedEvents.push({ atMs, from, to, reason, consecutiveBreaches: breachesAtChange });
  }
}
