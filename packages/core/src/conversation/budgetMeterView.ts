/**
 * Conversation budget meter — shared view contract (v1.07, Team T5).
 *
 * The *source of truth* for conversation spend is the harness meter
 * in `../risk/budget.ts` (`ConversationBudgetMeter`: records usage
 * per model, warns at 80%, exceeds at the cap, fires one alert per
 * threshold). T2's harness v3 feeds that meter; the renderer shows
 * it with `BudgetMeter` (App renders it above the chat when a
 * snapshot exists). This module is the contract *between* them —
 * the shape both sides agree on — so the harness, the voice
 * sessions, and the UI never drift apart again:
 *
 *   - `BudgetMeterView` — exactly the fields the renderer needs
 *     (a mirror of `BudgetSnapshotView` in the renderer types, plus
 *     the refined level and the meter segments). `toBudgetMeterView`
 *     builds it from a core `BudgetSnapshot`; the renderer never
 *     recomputes a level or a percentage from raw numbers.
 *   - `BudgetMeterLevel` — five levels, not three: the harness
 *     meter only knows ok / warning / exceeded, but a meter the
 *     user *watches* needs earlier steps. `watch` at 70% (start
 *     paying attention), `warning` at 80% (the harness threshold),
 *     `critical` at 90% (about to stop), `exceeded` at 100%+.
 *     The thresholds are exported constants, not magic numbers in
 *     the component.
 *   - `BudgetMeterSegment` — the stacked bar: input / output /
 *     free (remaining to the cap) / over (past the cap). With no
 *     cap the bar is input / output against the total spent. The
 *     component renders segments; it never invents them.
 *   - `budgetMeterMarkdown` — the same numbers as text, for the
 *     session log, the diagnostics panel, and the `voice_v6` tools
 *     that report spend alongside a call.
 *
 * Voice calls spend tokens too: a v6 session reports its turn
 * count, and `recordVoiceUsage()` converts voice turns into a
 * meter record (audio minutes are *not* tokens — the estimate is
 * labelled as such and the meter keeps the voice share separate in
 * the per-model breakdown under the `voice` model key, so a voice
 * estimate never inflates a text model's numbers).
 *
 * Pure functions + one small adapter class; no IPC, no storage.
 */
import type { BudgetSnapshot } from '../risk/types';

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
 * `BudgetSnapshot.percentUsed`; null = no cap, never over).
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
export function buildBudgetMeterSegments(snapshot: Pick<BudgetSnapshot, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'tokenLimit'>): BudgetMeterSegment[] {
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
  status: BudgetSnapshot['status'];
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
export function toBudgetMeterView(snapshot: BudgetSnapshot): BudgetMeterView {
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

/** Format a token count with thousands separators (locale-independent). */
export function formatBudgetTokens(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/** Format a USD cost (null = unknown, never a fake $0). */
export function formatBudgetCost(costUsd: number | null): string {
  if (costUsd === null) return '?';
  return `$${costUsd.toFixed(4)}`;
}

/** One-line summary for logs ("1,234/10,000 tokens (12.3%) — watch"). */
export function budgetMeterSummary(view: Pick<BudgetMeterView, 'totalTokens' | 'tokenLimit' | 'percentUsed' | 'level' | 'costUsd'>): string {
  const total = formatBudgetTokens(view.totalTokens);
  const cap = view.tokenLimit !== null ? formatBudgetTokens(view.tokenLimit) : 'no cap';
  const pct = view.percentUsed !== null ? ` (${view.percentUsed.toFixed(1)}%)` : '';
  const cost = view.costUsd !== null ? `, ${formatBudgetCost(view.costUsd)}` : '';
  return `${total}/${cap} tokens${pct}${cost} — ${view.level}`;
}

/** Markdown report of the meter (session log / diagnostics). */
export function budgetMeterMarkdown(view: BudgetMeterView): string {
  const lines = [
    `# Conversation budget — ${view.conversationId}`,
    '',
    `- Total: ${formatBudgetTokens(view.totalTokens)} tokens (${formatBudgetTokens(view.inputTokens)} in / ${formatBudgetTokens(view.outputTokens)} out)`,
    `- Estimated cost: ${formatBudgetCost(view.costUsd)}${view.hasUnknownCost ? ' (some models have no known price)' : ''}`,
    `- Token limit: ${view.tokenLimit !== null ? formatBudgetTokens(view.tokenLimit) : '(none)'}`,
    `- Cost limit: ${view.costLimitUsd !== null ? `$${view.costLimitUsd.toFixed(2)}` : '(none)'}`,
    `- Used: ${view.percentUsed !== null ? `${view.percentUsed.toFixed(1)}%` : '(no cap)'}`,
    `- Remaining: ${view.remainingTokens !== null ? `${formatBudgetTokens(view.remainingTokens)} tokens` : '(no cap)'}`,
    `- Level: ${view.level} (harness status: ${view.status})`,
    '',
  ];
  if (view.byModel.length > 0) {
    lines.push('| Model | In | Out | Share | Cost |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of view.byModel) {
      lines.push(
        `| ${row.model} | ${formatBudgetTokens(row.inputTokens)} | ${formatBudgetTokens(row.outputTokens)} | ` +
          `${(row.share * 100).toFixed(1)}% | ${formatBudgetCost(row.costUsd)} |`,
      );
    }
  } else {
    lines.push('No usage recorded yet.');
  }
  return lines.join('\n');
}

/**
 * Voice usage estimate, kept separate from text usage.
 *
 * A voice turn is not a token count: the estimate below is a
 * *planning* number only (roughly one minute of speech ≈ 800
 * tokens of transcript + reply, the same order of magnitude the
 * harness uses for its own estimates). The meter records it under
 * the model key `voice` so it never inflates a text model's
 * numbers, and the view marks it by the model name — a reader can
 * always tell the voice share apart.
 */
export const VOICE_BUDGET_MODEL_KEY = 'voice';
/** Rough tokens per minute of voice conversation (estimate only). */
export const VOICE_BUDGET_TOKENS_PER_MINUTE = 800;

/** Estimate voice tokens from call minutes (0 when the call was silent). */
export function estimateVoiceTokens(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes * VOICE_BUDGET_TOKENS_PER_MINUTE);
}
