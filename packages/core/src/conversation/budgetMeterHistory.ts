/**
 * Conversation budget history (v1.07, Team T5 — voice v4 + UI).
 *
 * The meter (`risk/budget.ts`) knows the *current* spend; the view
 * contract (`conversation/budgetMeterView.ts`) renders it. Neither
 * remembers *how* the conversation got there — whether spend crept
 * up slowly or spiked in one turn, or when it crossed 70%. This
 * module is that memory, kept small on purpose:
 *
 *   - `BudgetMeterHistory` records one point per meter
 *     snapshot (total tokens, cost, percent used, level, at). A
 *     point is skipped when nothing changed since the last one,
 *     so a quiet conversation does not grow the history.
 *   - Points are bounded (`maxPoints`, default 500, oldest dropped
 *     first) — a day-long conversation cannot grow the history
 *     without limit.
 *   - `sparkline()` renders the percent-used trend as block
 *     characters (▁▂▃▄▅▆▇█) for the diagnostics panel / logs —
 *     no chart library, no DOM.
 *   - `growthPerHour()` says how fast spend is climbing (tokens /
 *     hour between the first and last point, null when there is
 *     not enough history to say).
 *   - JSON round-trip (`toJSON` / `fromJSON`) so the host can
 *     persist the history next to the conversation and restore it.
 *
 * Pure data, no IPC, no storage — the host decides where the
 * history lives.
 */
import type { BudgetSnapshot } from '../risk/types';
import { budgetMeterLevel, type BudgetMeterLevel } from './budgetMeterView';

/** One recorded meter point. */
export interface BudgetMeterHistoryPoint {
  atMs: number;
  totalTokens: number;
  costUsd: number | null;
  percentUsed: number | null;
  level: BudgetMeterLevel;
}

/** Sparkline blocks, lowest to highest. */
export const BUDGET_SPARKLINE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export interface BudgetMeterHistoryOptions {
  /** Max points kept (oldest dropped first). Default 500. */
  maxPoints?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

export class BudgetMeterHistory {
  private readonly conversationId: string;
  private readonly maxPoints: number;
  private readonly clock: () => number;
  private readonly pointsList: BudgetMeterHistoryPoint[] = [];

  constructor(conversationId: string, options: BudgetMeterHistoryOptions = {}) {
    this.conversationId = conversationId;
    this.maxPoints = Math.max(1, options.maxPoints ?? 500);
    this.clock = options.clock ?? Date.now;
  }

  get id(): string {
    return this.conversationId;
  }

  /**
   * Record a meter snapshot. Skipped when the totals are identical
   * to the last point (nothing changed) — returns null then.
   */
  record(snapshot: BudgetSnapshot, atMs?: number): BudgetMeterHistoryPoint | null {
    const last = this.pointsList.at(-1);
    if (
      last &&
      last.totalTokens === snapshot.totalTokens &&
      last.costUsd === snapshot.costUsd &&
      last.percentUsed === snapshot.percentUsed
    ) {
      return null;
    }
    const point: BudgetMeterHistoryPoint = {
      atMs: atMs ?? this.clock(),
      totalTokens: snapshot.totalTokens,
      costUsd: snapshot.costUsd,
      percentUsed: snapshot.percentUsed,
      level: budgetMeterLevel(snapshot.percentUsed),
    };
    this.pointsList.push(point);
    if (this.pointsList.length > this.maxPoints) {
      this.pointsList.splice(0, this.pointsList.length - this.maxPoints);
    }
    return { ...point };
  }

  /** Points, oldest first (copies). */
  points(): BudgetMeterHistoryPoint[] {
    return this.pointsList.map((p) => ({ ...p }));
  }

  get count(): number {
    return this.pointsList.length;
  }

  latest(): BudgetMeterHistoryPoint | null {
    const last = this.pointsList.at(-1);
    return last ? { ...last } : null;
  }

  /** Highest percent used ever recorded (null when no cap / no points). */
  peakPercentUsed(): number | null {
    let peak: number | null = null;
    for (const point of this.pointsList) {
      if (point.percentUsed !== null && (peak === null || point.percentUsed > peak)) {
        peak = point.percentUsed;
      }
    }
    return peak;
  }

  /** Highest level ever reached. */
  peakLevel(): BudgetMeterLevel {
    let peak: BudgetMeterLevel = 'ok';
    const order: BudgetMeterLevel[] = ['ok', 'watch', 'warning', 'critical', 'exceeded'];
    for (const point of this.pointsList) {
      if (order.indexOf(point.level) > order.indexOf(peak)) peak = point.level;
    }
    return peak;
  }

  /**
   * Spend growth in tokens/hour between the first and last point.
   * Null with fewer than 2 points or no elapsed time.
   */
  growthPerHour(): number | null {
    if (this.pointsList.length < 2) return null;
    const first = this.pointsList[0];
    const last = this.pointsList[this.pointsList.length - 1];
    const hours = (last.atMs - first.atMs) / 3_600_000;
    if (hours <= 0) return null;
    return (last.totalTokens - first.totalTokens) / hours;
  }

  /**
   * Percent-used trend as block characters (one per point, oldest
   * first). Empty history renders '(no data)'; a flat line renders
   * one block repeated. Values are scaled to the max in the window,
   * not to 100 — the sparkline shows the *shape* of the climb.
   */
  sparkline(): string {
    if (this.pointsList.length === 0) return '(no data)';
    const values = this.pointsList.map((p) => p.percentUsed ?? 0);
    const max = Math.max(...values);
    if (max <= 0) return BUDGET_SPARKLINE_BLOCKS[0].repeat(values.length);
    return values
      .map((v) => {
        const index = Math.min(
          BUDGET_SPARKLINE_BLOCKS.length - 1,
          Math.floor((v / max) * BUDGET_SPARKLINE_BLOCKS.length),
        );
        return BUDGET_SPARKLINE_BLOCKS[index];
      })
      .join('');
  }

  /** Plain-JSON form (persist + restore). */
  toJSON(): { conversationId: string; points: BudgetMeterHistoryPoint[] } {
    return { conversationId: this.conversationId, points: this.points() };
  }

  /** Restore from `toJSON()` output (invalid input → empty history). */
  static fromJSON(data: unknown): BudgetMeterHistory {
    const fallback = new BudgetMeterHistory('unknown');
    if (!data || typeof data !== 'object') return fallback;
    const d = data as { conversationId?: unknown; points?: unknown };
    const history = new BudgetMeterHistory(
      typeof d.conversationId === 'string' ? d.conversationId : 'unknown',
    );
    if (!Array.isArray(d.points)) return history;
    for (const raw of d.points) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Partial<BudgetMeterHistoryPoint>;
      if (
        typeof p.atMs !== 'number' ||
        typeof p.totalTokens !== 'number' ||
        typeof p.level !== 'string'
      ) {
        continue;
      }
      history.pointsList.push({
        atMs: p.atMs,
        totalTokens: p.totalTokens,
        costUsd: typeof p.costUsd === 'number' ? p.costUsd : null,
        percentUsed: typeof p.percentUsed === 'number' ? p.percentUsed : null,
        level: p.level as BudgetMeterLevel,
      });
    }
    return history;
  }

  /** Markdown report (diagnostics / session log). */
  toMarkdown(): string {
    const latest = this.latest();
    const lines = [
      `# Budget history — ${this.conversationId} (${this.pointsList.length} point(s))`,
      '',
      `- Latest: ${latest ? `${latest.totalTokens.toLocaleString('en-US')} tokens (${latest.level})` : '(no data)'}`,
      `- Peak: ${this.peakPercentUsed() !== null ? `${this.peakPercentUsed()?.toFixed(1)}%` : '(no cap)'} (${this.peakLevel()})`,
      `- Growth: ${this.growthPerHour() !== null ? `~${Math.round(this.growthPerHour() ?? 0).toLocaleString('en-US')} tokens/hour` : '(not enough history)'}`,
      `- Trend: ${this.sparkline()}`,
    ];
    return lines.join('\n');
  }
}
