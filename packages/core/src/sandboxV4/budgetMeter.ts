/**
 * Sandbox v4 — conversation budget meter (v1.36, Team T4).
 *
 * One meter per conversation. It tracks four dimensions —
 * input tokens, output tokens, dollars, wall-clock time —
 * against per-conversation limits. Each dimension has a
 * warning ratio (default 80%) and a hard limit:
 *
 *   used < warnAtRatio × limit   → `ok`
 *   warnAtRatio ≤ used < limit   → `warning`
 *   used ≥ limit (limit > 0)     → `soft-blocked`
 *
 * A limit of 0 means that dimension is unlimited and can never
 * warn or block. The meter is a *soft* block: `recordUsage`
 * still records the step that crossed the limit (so the overrun
 * is visible in the history) but reports `soft-blocked`, and
 * `check()` keeps reporting it until the limits are raised or
 * the meter is reset. The runtime asks the meter before every
 * new step and refuses to start one while soft-blocked.
 *
 * Cost is estimated from a builtin per-model price table
 * (USD per 1M tokens, input / output). Unknown models fall back
 * to a documented default rate; local models (`ollama/...`,
 * `local/...`) cost 0. Prices are estimates for budgeting, not
 * bills — the meter says so in every report. The table is
 * deliberately small and explicit; adding a model is one line.
 *
 * Usage history is a ring buffer (default 200 steps): old steps
 * drop off so a long conversation cannot grow the meter without
 * bound, while the totals always stay exact.
 */

import type {
  SandboxV4BudgetDimension,
  SandboxV4BudgetLimits,
  SandboxV4BudgetRecordResult,
  SandboxV4BudgetState,
  SandboxV4BudgetStatus,
  SandboxV4BudgetStep,
  SandboxV4BudgetUsage,
} from './types';

/** Default warning ratio: warn at 80% of any limit. */
export const SANDBOX_V4_BUDGET_DEFAULT_WARN_RATIO = 0.8;

/** Default step history size (ring buffer). */
export const SANDBOX_V4_BUDGET_DEFAULT_HISTORY = 200;

/** Max step history size. */
export const SANDBOX_V4_BUDGET_MAX_HISTORY = 2000;

/** Fallback price (USD per 1M tokens) for an unknown model. */
export const SANDBOX_V4_BUDGET_FALLBACK_PRICE = { inputPerM: 3.0, outputPerM: 15.0 } as const;

/** Price table: USD per 1M tokens, input / output. Estimates, not bills. */
export const SANDBOX_V4_MODEL_PRICES: Readonly<Record<string, { inputPerM: number; outputPerM: number }>> = {
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4.1': { inputPerM: 2.0, outputPerM: 8.0 },
  'gpt-5': { inputPerM: 1.25, outputPerM: 10.0 },
  'claude-sonnet-4': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4': { inputPerM: 15.0, outputPerM: 75.0 },
  'claude-haiku-3.5': { inputPerM: 0.8, outputPerM: 4.0 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  'gemini-3-pro': { inputPerM: 2.0, outputPerM: 12.0 },
  'grok-4': { inputPerM: 3.0, outputPerM: 15.0 },
  'grok-4.1': { inputPerM: 3.0, outputPerM: 15.0 },
  'grok-code-fast-1': { inputPerM: 0.2, outputPerM: 1.5 },
  'deepseek-chat': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek-reasoner': { inputPerM: 0.55, outputPerM: 2.19 },
  'qwen3-coder': { inputPerM: 0.4, outputPerM: 1.6 },
};

/** Model id prefixes that always cost 0 (local execution). */
export const SANDBOX_V4_LOCAL_MODEL_PREFIXES = ['ollama/', 'local/', 'llama.cpp/', 'lm-studio/'] as const;

/** True when the model id is a local (zero-cost) model. */
export function isSandboxV4LocalModel(model: string): boolean {
  const lower = model.toLowerCase();
  return SANDBOX_V4_LOCAL_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Price for a model id (exact match, then case-insensitive, then fallback). */
export function priceForSandboxV4Model(model: string): { inputPerM: number; outputPerM: number } {
  if (model === '' || isSandboxV4LocalModel(model)) {
    return { inputPerM: 0, outputPerM: 0 };
  }
  const exact = SANDBOX_V4_MODEL_PRICES[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(SANDBOX_V4_MODEL_PRICES)) {
    if (key.toLowerCase() === lower) return price;
  }
  return { ...SANDBOX_V4_BUDGET_FALLBACK_PRICE };
}

/** Estimate the cost of one step in USD. */
export function estimateSandboxV4StepCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceForSandboxV4Model(model);
  const cost = (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Default limits: 200k input / 50k output tokens, $5, 1 hour. */
export function defaultSandboxV4BudgetLimits(): SandboxV4BudgetLimits {
  return {
    maxInputTokens: 200_000,
    maxOutputTokens: 50_000,
    maxCostUsd: 5,
    maxWallMs: 3_600_000,
    warnAtRatio: SANDBOX_V4_BUDGET_DEFAULT_WARN_RATIO,
  };
}

/** Validate budget limits. Returns problems (empty = valid). */
export function validateSandboxV4BudgetLimits(limits: unknown): string[] {
  const problems: string[] = [];
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    return ['Budget limits must be an object.'];
  }
  const value = limits as Record<string, unknown>;
  const ints: Array<[string, number]> = [
    ['maxInputTokens', 100_000_000],
    ['maxOutputTokens', 100_000_000],
    ['maxWallMs', 86_400_000],
  ];
  for (const [key, max] of ints) {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      problems.push(`${key} must be a non-negative integer.`);
    } else if (v > max) {
      problems.push(`${key} must be at most ${max}.`);
    }
  }
  const cost = value.maxCostUsd;
  if (typeof cost !== 'number' || Number.isNaN(cost) || cost < 0) {
    problems.push('maxCostUsd must be a non-negative number.');
  } else if (cost > 10_000) {
    problems.push('maxCostUsd must be at most 10000.');
  }
  const ratio = value.warnAtRatio;
  if (typeof ratio !== 'number' || Number.isNaN(ratio) || ratio <= 0 || ratio > 1) {
    problems.push('warnAtRatio must be a number in (0, 1].');
  }
  return problems;
}

const DIMENSIONS: SandboxV4BudgetDimension[] = ['inputTokens', 'outputTokens', 'costUsd', 'wallMs'];

function limitFor(limits: SandboxV4BudgetLimits, dim: SandboxV4BudgetDimension): number {
  if (dim === 'inputTokens') return limits.maxInputTokens;
  if (dim === 'outputTokens') return limits.maxOutputTokens;
  if (dim === 'costUsd') return limits.maxCostUsd;
  return limits.maxWallMs;
}

function usedFor(usage: SandboxV4BudgetUsage, dim: SandboxV4BudgetDimension): number {
  if (dim === 'inputTokens') return usage.inputTokens;
  if (dim === 'outputTokens') return usage.outputTokens;
  if (dim === 'costUsd') return usage.costUsd;
  return usage.wallMs;
}

export interface SandboxV4BudgetMeterOptions {
  /** Conversation the meter belongs to. */
  conversationId: string;
  /** Starting limits (default: defaultSandboxV4BudgetLimits()). */
  limits?: SandboxV4BudgetLimits;
  /** Step history size (default 200, clamped to 1..2000). */
  historySize?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * One conversation's budget meter. Owns limits, usage, history
 * and status. All mutations go through `recordUsage`,
 * `setLimits` and `reset` so the status is always consistent.
 */
export class SandboxV4BudgetMeter {
  private readonly conversationId: string;
  private limits: SandboxV4BudgetLimits;
  private usage: SandboxV4BudgetUsage;
  private readonly historySize: number;
  private readonly nowMs: () => number;
  private readonly steps: SandboxV4BudgetStep[] = [];
  private seq = 0;
  private readonly createdAtMs: number;
  private lastResetAtMs = 0;

  constructor(options: SandboxV4BudgetMeterOptions) {
    if (typeof options.conversationId !== 'string' || options.conversationId === '') {
      throw new Error('Budget meter needs a non-empty conversationId.');
    }
    const limits = options.limits ?? defaultSandboxV4BudgetLimits();
    const problems = validateSandboxV4BudgetLimits(limits);
    if (problems.length > 0) {
      throw new Error(`Invalid budget limits: ${problems.join(' ')}`);
    }
    this.conversationId = options.conversationId;
    this.limits = { ...limits };
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, steps: 0 };
    const requested = options.historySize ?? SANDBOX_V4_BUDGET_DEFAULT_HISTORY;
    this.historySize = Math.min(Math.max(Math.floor(requested), 1), SANDBOX_V4_BUDGET_MAX_HISTORY);
    this.nowMs = options.nowMs ?? Date.now;
    this.createdAtMs = this.nowMs();
  }

  /** Conversation this meter belongs to. */
  getConversationId(): string {
    return this.conversationId;
  }

  /** Active limits (copy). */
  getLimits(): SandboxV4BudgetLimits {
    return { ...this.limits };
  }

  /** Usage so far (copy). */
  getUsage(): SandboxV4BudgetUsage {
    return { ...this.usage };
  }

  /** Used ratio for one dimension (0 when unlimited, >1 when over). */
  ratioFor(dim: SandboxV4BudgetDimension): number {
    const limit = limitFor(this.limits, dim);
    if (limit <= 0) return 0;
    return usedFor(this.usage, dim) / limit;
  }

  /** Ratios for all dimensions. */
  ratios(): Record<SandboxV4BudgetDimension, number> {
    const out = {} as Record<SandboxV4BudgetDimension, number>;
    for (const dim of DIMENSIONS) out[dim] = this.ratioFor(dim);
    return out;
  }

  /** Dimensions at or over the warning ratio (but under the hard limit). */
  warningDimensions(): SandboxV4BudgetDimension[] {
    return DIMENSIONS.filter((dim) => {
      const limit = limitFor(this.limits, dim);
      if (limit <= 0) return false;
      const ratio = this.ratioFor(dim);
      return ratio >= this.limits.warnAtRatio && ratio < 1;
    });
  }

  /** Dimensions over a hard limit. */
  blockedDimensions(): SandboxV4BudgetDimension[] {
    return DIMENSIONS.filter((dim) => {
      const limit = limitFor(this.limits, dim);
      if (limit <= 0) return false;
      return usedFor(this.usage, dim) >= limit;
    });
  }

  /** Current status: ok / warning / soft-blocked. */
  status(): SandboxV4BudgetStatus {
    if (this.blockedDimensions().length > 0) return 'soft-blocked';
    if (this.warningDimensions().length > 0) return 'warning';
    return 'ok';
  }

  /** True when a new step may start (not soft-blocked). */
  mayStartStep(): boolean {
    return this.status() !== 'soft-blocked';
  }

  /** Remaining headroom per dimension (null when unlimited). */
  remaining(): {
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    wallMs: number | null;
  } {
    const rem = (dim: SandboxV4BudgetDimension): number | null => {
      const limit = limitFor(this.limits, dim);
      if (limit <= 0) return null;
      return Math.max(0, limit - usedFor(this.usage, dim));
    };
    const costRem = rem('costUsd');
    return {
      inputTokens: rem('inputTokens'),
      outputTokens: rem('outputTokens'),
      costUsd: costRem === null ? null : Math.max(0, Math.round(costRem * 1_000_000) / 1_000_000),
      wallMs: rem('wallMs'),
    };
  }

  /**
   * Record one step. Cost is estimated from the model price
   * table unless `costUsd` is given explicitly (provider-reported
   * cost wins). Returns the status after recording.
   */
  recordUsage(input: {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    wallMs?: number;
    costUsd?: number;
  }): SandboxV4BudgetRecordResult {
    const wasBlocked = this.status() === 'soft-blocked';
    const inTokens = Math.max(0, Math.floor(input.inputTokens));
    const outTokens = Math.max(0, Math.floor(input.outputTokens));
    const wall = Math.max(0, Math.floor(input.wallMs ?? 0));
    const model = input.model ?? '';
    const stepCost =
      input.costUsd !== undefined
        ? Math.max(0, input.costUsd)
        : estimateSandboxV4StepCost(model, inTokens, outTokens);
    this.seq += 1;
    this.usage.inputTokens += inTokens;
    this.usage.outputTokens += outTokens;
    this.usage.costUsd = Math.round((this.usage.costUsd + stepCost) * 1_000_000) / 1_000_000;
    this.usage.wallMs += wall;
    this.usage.steps += 1;
    this.steps.push({
      seq: this.seq,
      atMs: this.nowMs(),
      model,
      inputTokens: inTokens,
      outputTokens: outTokens,
      costUsd: stepCost,
      wallMs: wall,
    });
    while (this.steps.length > this.historySize) this.steps.shift();
    const status = this.status();
    return {
      status,
      newlyBlocked: !wasBlocked && status === 'soft-blocked',
      blockedDimensions: this.blockedDimensions(),
      stepCostUsd: stepCost,
      state: this.describe(),
    };
  }

  /** Replace the limits (validated). Returns problems (empty = applied). */
  setLimits(limits: SandboxV4BudgetLimits): string[] {
    const problems = validateSandboxV4BudgetLimits(limits);
    if (problems.length > 0) return problems;
    this.limits = { ...limits };
    return [];
  }

  /** Raise one limit to at least `minValue` (operator override). */
  raiseLimit(dim: SandboxV4BudgetDimension, minValue: number): string[] {
    const next: SandboxV4BudgetLimits = { ...this.limits };
    if (dim === 'inputTokens') next.maxInputTokens = Math.max(next.maxInputTokens, Math.floor(minValue));
    if (dim === 'outputTokens') next.maxOutputTokens = Math.max(next.maxOutputTokens, Math.floor(minValue));
    if (dim === 'costUsd') next.maxCostUsd = Math.max(next.maxCostUsd, minValue);
    if (dim === 'wallMs') next.maxWallMs = Math.max(next.maxWallMs, Math.floor(minValue));
    return this.setLimits(next);
  }

  /** Reset usage and history to zero (limits stay). */
  reset(): void {
    this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, steps: 0 };
    this.steps.length = 0;
    this.lastResetAtMs = this.nowMs();
  }

  /**
   * Forecast: at the current average cost per step, how many more
   * steps fit before the cost limit (null when unlimited or no
   * steps recorded yet)? Honest estimate, labelled as such.
   */
  forecastStepsLeft(): number | null {
    if (this.limits.maxCostUsd <= 0) return null;
    if (this.usage.steps === 0) return null;
    const avg = this.usage.costUsd / this.usage.steps;
    if (avg <= 0) return null;
    return Math.max(0, Math.floor((this.limits.maxCostUsd - this.usage.costUsd) / avg));
  }

  /** Full meter state for status / report endpoints. */
  describe(): SandboxV4BudgetState {
    return {
      conversationId: this.conversationId,
      limits: { ...this.limits },
      usage: { ...this.usage },
      status: this.status(),
      warningDimensions: this.warningDimensions(),
      blockedDimensions: this.blockedDimensions(),
      ratios: this.ratios(),
      remaining: this.remaining(),
      steps: this.steps.map((step) => ({ ...step })),
      createdAtMs: this.createdAtMs,
      lastResetAtMs: this.lastResetAtMs,
    };
  }

  /** One-line status for logs (no model internals, no secrets). */
  statusLine(): string {
    const state = this.describe();
    const pct = (dim: SandboxV4BudgetDimension): string => {
      const limit = limitFor(this.limits, dim);
      if (limit <= 0) return '∞';
      return `${Math.round(this.ratioFor(dim) * 100)}%`;
    };
    return (
      `budget ${this.conversationId}: ${state.status} ` +
      `(in ${pct('inputTokens')} / out ${pct('outputTokens')} / ` +
      `$${pct('costUsd')} / time ${pct('wallMs')}, ` +
      `$${state.usage.costUsd.toFixed(4)} spent, ${state.usage.steps} steps)`
    );
  }
}
