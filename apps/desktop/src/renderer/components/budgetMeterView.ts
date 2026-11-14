/**
 * Conversation budget meter — renderer-local view contract (v1.07 merge fix).
 *
 * This is a deliberate, self-contained mirror of the pure view logic in
 * core (`packages/core/src/conversation/budgetMeterView.ts`): same
 * thresholds (watch 70 / warning 80 / critical 90), same segment math,
 * same view shape. It lives here instead of being imported from core
 * because the renderer (vite/rollup) cannot consume the core CJS
 * bundles: importing `@open-bot/core/dist/...` inlines the CJS file
 * verbatim (`Object.defineProperty(exports, ...)` with no `exports`
 * in scope), which throws `ReferenceError: exports is not defined`
 * at startup and leaves the app on a blank screen (React never
 * mounts). The renderer convention is self-contained components with
 * only `import type` from core — value imports from core are banned
 * in `src/renderer` for exactly this reason.
 *
 * Keep in sync with core by hand: if core changes a threshold or the
 * segment math, update this file in the same commit. The core side is
 * covered by `tests/voice-v107.test.mjs` (`toBudgetMeterView` cases);
 * the renderer side is covered by the BudgetMeter component tests.
 */
import type { BudgetSnapshotView } from '../types';

/** Refined meter level (the harness meter only has ok/warning/exceeded). */
export type BudgetMeterLevel = 'ok' | 'watch' | 'warning' | 'critical' | 'exceeded';

/** Percent used at which the meter turns `watch` (start paying attention). */
export const BUDGET_METER_WATCH_PERCENT = 70;
/** Percent used at which the meter turns `warning` (the harness threshold). */
export const BUDGET_METER_WARNING_PERCENT = 80;
/** Percent used at which the meter turns `critical` (about to stop). */
export const BUDGET_METER_CRITICAL_PERCENT = 90;

/**
 * Level for a percent-used value (0–100, the same scale as
 * `BudgetSnapshotView.percentUsed`; null = no cap, never over).
 */
export function budgetMeterLevel(percentUsed: number | null): BudgetMeterLevel {
  if (percentUsed === null || !Number.isFinite(percentUsed)) return 'ok';
  if (percentUsed >= 100) return 'exceeded';
  if (percentUsed >= BUDGET_METER_CRITICAL_PERCENT) return 'critical';
  if (percentUsed >= BUDGET_METER_WARNING_PERCENT) return 'warning';
  if (percentUsed >= BUDGET_METER_WATCH_PERCENT) return 'watch';
  return 'ok';
}

/** One slice of the stacked meter bar. Ratios sum to ~1 (or 0 when empty). */
export interface BudgetMeterSegment {
  key: 'input' | 'output' | 'free' | 'over';
  /** Tokens in this slice. */
  tokens: number;
  /** Share of the bar (0..1). */
  ratio: number;
}

/**
 * Build the stacked-bar segments for a snapshot. With a token cap
 * the bar is input + output + free (or over, past the cap); without
 * a cap it is input + output against the total spent (no free
 * slice — there is nothing to be free *of*).
 */
export function buildBudgetMeterSegments(
  snapshot: Pick<BudgetSnapshotView, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'tokenLimit'>,
): BudgetMeterSegment[] {
  const input = Math.max(0, snapshot.inputTokens);
  const output = Math.max(0, snapshot.outputTokens);
  const limit = snapshot.tokenLimit;
  if (limit !== null && limit > 0) {
    const total = input + output;
    if (total >= limit) {
      const over = total - limit;
      return [
        { key: 'input', tokens: input, ratio: input / total },
        { key: 'output', tokens: output, ratio: output / total },
        { key: 'over', tokens: over, ratio: over / total },
      ];
    }
    return [
      { key: 'input', tokens: input, ratio: input / limit },
      { key: 'output', tokens: output, ratio: output / limit },
      { key: 'free', tokens: limit - total, ratio: (limit - total) / limit },
    ];
  }
  const total = Math.max(1, snapshot.totalTokens);
  return [
    { key: 'input', tokens: input, ratio: input / total },
    { key: 'output', tokens: output, ratio: output / total },
  ];
}

/** One per-model row for the meter breakdown. */
export interface BudgetMeterModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Share of the conversation's tokens (0..1). */
  share: number;
  costUsd: number | null;
}

/**
 * The view the renderer renders. Every field is computed here, so
 * the component is a pure render of this object (plus i18n).
 */
export interface BudgetMeterView {
  conversationId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  hasUnknownCost: boolean;
  tokenLimit: number | null;
  costLimitUsd: number | null;
  tokenPercentUsed: number | null;
  costPercentUsed: number | null;
  /** Percent used (0–100, same scale as the harness snapshot; null when no cap). */
  percentUsed: number | null;
  /** Harness status (ok / warning / exceeded). */
  status: BudgetSnapshotView['status'];
  /** Refined UI level (ok / watch / warning / critical / exceeded). */
  level: BudgetMeterLevel;
  /** Stacked-bar segments. */
  segments: BudgetMeterSegment[];
  /** Tokens left under the token cap (null when no cap / over). */
  remainingTokens: number | null;
  /** USD left under the cost cap (null when no cap / unknown cost). */
  remainingCostUsd: number | null;
  /** Per-model breakdown, largest first. */
  byModel: BudgetMeterModelRow[];
  lastRecordedAtMs: number | null;
}

/** Build the renderer view from a harness-meter snapshot. */
export function toBudgetMeterView(snapshot: BudgetSnapshotView): BudgetMeterView {
  const segments = buildBudgetMeterSegments(snapshot);
  const level = budgetMeterLevel(snapshot.percentUsed);
  const remainingTokens =
    snapshot.tokenLimit !== null
      ? Math.max(0, snapshot.tokenLimit - snapshot.totalTokens)
      : null;
  const remainingCostUsd =
    snapshot.costLimitUsd !== null && snapshot.costUsd !== null
      ? Math.max(0, snapshot.costLimitUsd - snapshot.costUsd)
      : null;
  const total = Math.max(1, snapshot.totalTokens);
  const byModel: BudgetMeterModelRow[] = Object.entries(snapshot.byModel)
    .map(([model, usage]) => ({
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      share: (usage.inputTokens + usage.outputTokens) / total,
      costUsd: usage.costUsd,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    conversationId: snapshot.conversationId,
    model: snapshot.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    totalTokens: snapshot.totalTokens,
    costUsd: snapshot.costUsd,
    hasUnknownCost: snapshot.hasUnknownCost,
    tokenLimit: snapshot.tokenLimit,
    costLimitUsd: snapshot.costLimitUsd,
    tokenPercentUsed: snapshot.tokenPercentUsed,
    costPercentUsed: snapshot.costPercentUsed,
    percentUsed: snapshot.percentUsed,
    status: snapshot.status,
    level,
    segments,
    remainingTokens,
    remainingCostUsd,
    byModel,
    lastRecordedAtMs: snapshot.lastRecordedAtMs,
  };
}
