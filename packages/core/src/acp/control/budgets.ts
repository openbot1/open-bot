/**
 * Budget evaluation for the ACP Control Center (v1.12, Team T4).
 *
 * Pure functions over today's usage + one agent's budget policy:
 * no I/O, no clock reads inside the evaluator (the caller passes
 * the day + usage), so tests can pin exact boundaries.
 *
 * Rules:
 * - A dimension with no cap is unlimited (fraction null, never
 *   warned/exceeded).
 * - `warned` at `warnAtFraction` (default 0.8) of the cap, `exceeded`
 *   at >= 100%. A single call may push usage slightly past a cap —
 *   the NEXT turn is then blocked, same contract as the core spend
 *   limits (`packages/core/src/usage/usage.ts`).
 * - Cost: turns with unknown cost (null) count 0 toward the cost
 *   dimension but are reported separately via `unpricedCalls`, so a
 *   cost cap never silently passes on unpriced usage.
 */

import {
  DEFAULT_BUDGET_WARN_FRACTION,
  emptyUsageSummary,
  localDay,
  type AgentBudget,
  type AgentUsageSummary,
  type BudgetDimensionState,
  type BudgetEvaluation,
} from './types';

export const BUDGET_DIMENSION_LABELS: Record<BudgetDimensionState['dimension'], string> = {
  tokens: 'tokens',
  cost: 'cost (USD)',
  calls: 'calls',
  wallMs: 'wall time',
};

/** Evaluate one dimension (used vs optional cap). */
export function evaluateDimension(
  dimension: BudgetDimensionState['dimension'],
  used: number,
  limit: number | undefined,
  warnAtFraction: number,
): BudgetDimensionState {
  if (limit === undefined || limit <= 0) {
    return { dimension, used, limit: undefined, fractionUsed: null, warned: false, exceeded: false };
  }
  const fractionUsed = used / limit;
  return {
    dimension,
    used,
    limit,
    fractionUsed,
    warned: fractionUsed >= warnAtFraction && fractionUsed < 1,
    exceeded: fractionUsed >= 1,
  };
}

/** Evaluate a whole budget policy against today's usage. */
export function evaluateBudget(
  agentId: string,
  budget: AgentBudget,
  today: AgentUsageSummary,
  day: string = localDay(),
): BudgetEvaluation {
  const warnAt = budget.warnAtFraction ?? DEFAULT_BUDGET_WARN_FRACTION;
  const dimensions: BudgetDimensionState[] = [
    evaluateDimension('tokens', today.totalTokens, budget.maxTokensPerDay, warnAt),
    evaluateDimension('cost', today.costUsd ?? 0, budget.maxCostUsdPerDay, warnAt),
    evaluateDimension('calls', today.calls, budget.maxCallsPerDay, warnAt),
    evaluateDimension('wallMs', today.wallMs, budget.maxWallMsPerDay, warnAt),
  ];
  const reasons: string[] = [];
  for (const dim of dimensions) {
    if (dim.limit === undefined) continue;
    const label = BUDGET_DIMENSION_LABELS[dim.dimension];
    if (dim.exceeded) {
      reasons.push(`${label} exceeded: ${formatUsed(dim)} of ${formatLimit(dim)}`);
    } else if (dim.warned) {
      reasons.push(`${label} at ${Math.round((dim.fractionUsed ?? 0) * 100)}% of ${formatLimit(dim)}`);
    }
  }
  return {
    agentId,
    day,
    dimensions,
    blocked: dimensions.some((d) => d.exceeded),
    warned: dimensions.some((d) => d.warned) && !dimensions.some((d) => d.exceeded),
    reasons,
  };
}

/** Convenience: evaluate with an empty (zero-usage) day. */
export function evaluateBudgetEmpty(agentId: string, budget: AgentBudget, day: string = localDay()): BudgetEvaluation {
  return evaluateBudget(agentId, budget, emptyUsageSummary(), day);
}

function formatUsed(dim: BudgetDimensionState): string {
  if (dim.dimension === 'cost') return `$${dim.used.toFixed(2)}`;
  if (dim.dimension === 'wallMs') return formatWallMs(dim.used);
  return String(dim.used);
}

function formatLimit(dim: BudgetDimensionState): string {
  if (dim.limit === undefined) return 'unlimited';
  if (dim.dimension === 'cost') return `$${dim.limit.toFixed(2)}`;
  if (dim.dimension === 'wallMs') return formatWallMs(dim.limit);
  return String(dim.limit);
}

/** Human duration: 90_000 -> "1m 30s", 3_600_000 -> "1h 0m". */
export function formatWallMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Validate a budget policy the user typed in. Returns error strings
 * (empty = valid). Caps must be positive finite numbers; the warn
 * fraction must be in (0, 1].
 */
export function validateBudget(budget: AgentBudget): string[] {
  const errors: string[] = [];
  const checkCap = (name: string, value: number | undefined, integerOnly: boolean) => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value <= 0) errors.push(`${name} must be a positive number.`);
    else if (integerOnly && !Number.isInteger(value)) errors.push(`${name} must be a whole number.`);
  };
  checkCap('maxTokensPerDay', budget.maxTokensPerDay, true);
  checkCap('maxCostUsdPerDay', budget.maxCostUsdPerDay, false);
  checkCap('maxCallsPerDay', budget.maxCallsPerDay, true);
  checkCap('maxWallMsPerDay', budget.maxWallMsPerDay, true);
  if (budget.warnAtFraction !== undefined) {
    if (!Number.isFinite(budget.warnAtFraction) || budget.warnAtFraction <= 0 || budget.warnAtFraction > 1) {
      errors.push('warnAtFraction must be between 0 and 1.');
    }
  }
  if (budget.stopOnExceed !== undefined && typeof budget.stopOnExceed !== 'boolean') {
    errors.push('stopOnExceed must be a boolean.');
  }
  return errors;
}

/** Merge a partial budget patch over the current policy (undefined fields in the patch clear that cap). */
export function applyBudgetPatch(current: AgentBudget, patch: Partial<AgentBudget>): AgentBudget {
  return { ...current, ...patch };
}
