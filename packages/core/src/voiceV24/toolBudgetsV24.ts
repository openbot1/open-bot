/**
 * Tool-call time budgets for voice v24 (v1.37, Team T5).
 *
 * Timers measure; budgets judge. A voice session that
 * spends 40 seconds of a 60-second turn on tool calls has
 * no time left to speak — the operator should know before
 * the turn ends, not after. The budget registry holds:
 *
 *   - a per-call budget per tool (a single `web_search`
 *     that runs 20s is a problem even if the session
 *     total is fine);
 *   - a per-session tool-time budget (all calls in one
 *     session added up);
 *   - a per-turn tool-time budget (all calls in one turn
 *     added up);
 *   - burn-down: spent / remaining / projected overrun at
 *     the current burn rate, so the panel can show "12s
 *     left at this rate" instead of just "spent 48s".
 *
 * Breaches are computed from finished calls the caller
 * reports (via `recordFinished`) plus live running calls
 * the caller reports (via `recordRunning`) — the registry
 * never starts its own timers. All clocks virtual.
 */
import {
  clampV24,
  formatDurationV24,
  round2V24,
  type VoiceV24ToolCallRecord,
} from './types';

export interface ToolBudgetV24Options {
  /** Default per-call budget when a tool has none (default 10000 ms). */
  defaultPerCallMs: number;
  /** Default per-session tool-time budget (default 120000 ms). */
  defaultSessionMs: number;
  /** Default per-turn tool-time budget (default 30000 ms). */
  defaultTurnMs: number;
  /** Burn-rate window: calls in the last N ms count (default 60000 ms). */
  burnWindowMs: number;
}

export function defaultToolBudgetV24Options(): ToolBudgetV24Options {
  return {
    defaultPerCallMs: 10000,
    defaultSessionMs: 120000,
    defaultTurnMs: 30000,
    burnWindowMs: 60000,
  };
}

export function validateToolBudgetV24Options(o: Partial<ToolBudgetV24Options>): string[] {
  const errors: string[] = [];
  if (o.defaultPerCallMs !== undefined && !(o.defaultPerCallMs > 0 && o.defaultPerCallMs <= 600000)) {
    errors.push('defaultPerCallMs must be > 0 and <= 600000');
  }
  if (o.defaultSessionMs !== undefined && !(o.defaultSessionMs > 0 && o.defaultSessionMs <= 3600000)) {
    errors.push('defaultSessionMs must be > 0 and <= 3600000');
  }
  if (o.defaultTurnMs !== undefined && !(o.defaultTurnMs > 0 && o.defaultTurnMs <= 600000)) {
    errors.push('defaultTurnMs must be > 0 and <= 600000');
  }
  if (o.burnWindowMs !== undefined && !(o.burnWindowMs > 0 && o.burnWindowMs <= 3600000)) {
    errors.push('burnWindowMs must be > 0 and <= 3600000');
  }
  return errors;
}

/** Budgets for one tool (all optional — defaults fill the gaps). */
export interface VoiceV24ToolBudget {
  toolName: string;
  perCallMs?: number;
  perSessionMs?: number;
  perTurnMs?: number;
}

export type VoiceV24BudgetBreachKind = 'per-call' | 'per-session' | 'per-turn';

/** One budget breach, with the numbers that prove it. */
export interface VoiceV24BudgetBreach {
  id: string;
  sessionId: string;
  toolName: string;
  kind: VoiceV24BudgetBreachKind;
  spentMs: number;
  budgetMs: number;
  overByMs: number;
  atMs: number;
  callId?: string;
  turnIndex?: number;
}

/** Burn-down of one budget: spent, remaining, projected finish. */
export interface VoiceV24BurnDown {
  budgetMs: number;
  spentMs: number;
  remainingMs: number;
  /** 0..1+ share of the budget spent (over 1 = breached). */
  spentRatio: number;
  /** ms of tool time per second inside the burn window. */
  burnRateMsPerSecond: number;
  /** ms until the budget is exhausted at the current burn rate (null when not burning). */
  projectedExhaustionInMs: number | null;
  breached: boolean;
}

export function createToolBudgetRegistryV24(
  opts: Partial<ToolBudgetV24Options> = {},
): ToolBudgetRegistryV24 {
  return new ToolBudgetRegistryV24(opts);
}

export class ToolBudgetRegistryV24 {
  private readonly opts: ToolBudgetV24Options;
  private readonly budgets = new Map<string, VoiceV24ToolBudget>();
  private readonly breaches: VoiceV24BudgetBreach[] = [];
  private readonly breachKeys = new Set<string>();
  private seq = 0;
  /** Session-level overrides: sessionId -> budget ms. */
  private readonly sessionBudgets = new Map<string, number>();

  constructor(opts: Partial<ToolBudgetV24Options> = {}) {
    const errors = validateToolBudgetV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ToolBudgetRegistryV24 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultToolBudgetV24Options(), ...opts };
  }

  options(): ToolBudgetV24Options {
    return { ...this.opts };
  }

  /** Set (or replace) the budgets for one tool. */
  setBudget(budget: VoiceV24ToolBudget): void {
    if (typeof budget.toolName !== 'string' || budget.toolName.length === 0) {
      throw new Error('toolName must be a non-empty string');
    }
    for (const [key, value] of [
      ['perCallMs', budget.perCallMs],
      ['perSessionMs', budget.perSessionMs],
      ['perTurnMs', budget.perTurnMs],
    ] as const) {
      if (value !== undefined && !(value > 0 && Number.isFinite(value))) {
        throw new Error(`${key} must be > 0`);
      }
    }
    this.budgets.set(budget.toolName, { ...budget });
  }

  /** Remove one tool's budgets (defaults apply again). True when it existed. */
  removeBudget(toolName: string): boolean {
    return this.budgets.delete(toolName);
  }

  getBudget(toolName: string): VoiceV24ToolBudget {
    const stored = this.budgets.get(toolName);
    return {
      toolName,
      perCallMs: stored?.perCallMs ?? this.opts.defaultPerCallMs,
      perSessionMs: stored?.perSessionMs ?? this.opts.defaultSessionMs,
      perTurnMs: stored?.perTurnMs ?? this.opts.defaultTurnMs,
    };
  }

  /** Override the session tool-time budget for one session. */
  setSessionBudget(sessionId: string, budgetMs: number): void {
    if (!(budgetMs > 0 && Number.isFinite(budgetMs))) throw new Error('budgetMs must be > 0');
    this.sessionBudgets.set(sessionId, budgetMs);
  }

  sessionBudgetMs(sessionId: string): number {
    return this.sessionBudgets.get(sessionId) ?? this.opts.defaultSessionMs;
  }

  perCallBudgetMs(toolName: string): number {
    return this.getBudget(toolName).perCallMs as number;
  }

  /**
   * Check one finished call against its budgets, given the
   * session and turn totals *including* this call. Returns
   * the breaches it raised (deduplicated per call+kind).
   */
  recordFinished(
    record: VoiceV24ToolCallRecord,
    sessionTotalMs: number,
    turnTotalMs: number,
  ): VoiceV24BudgetBreach[] {
    if (record.durationMs === null) {
      throw new Error(`Call "${record.id}" has no duration yet`);
    }
    const raised: VoiceV24BudgetBreach[] = [];
    const budget = this.getBudget(record.toolName);
    const checks: {
      kind: VoiceV24BudgetBreachKind;
      spentMs: number;
      budgetMs: number;
      key: string;
    }[] = [
      {
        kind: 'per-call',
        spentMs: record.durationMs,
        budgetMs: budget.perCallMs as number,
        key: `call:${record.id}`,
      },
      {
        kind: 'per-session',
        spentMs: sessionTotalMs,
        budgetMs: this.sessionBudgetMs(record.sessionId),
        key: `session:${record.sessionId}`,
      },
      {
        kind: 'per-turn',
        spentMs: turnTotalMs,
        budgetMs: budget.perTurnMs as number,
        key: `turn:${record.sessionId}:${record.turnIndex}`,
      },
    ];
    for (const check of checks) {
      if (check.spentMs <= check.budgetMs) continue;
      if (this.breachKeys.has(check.key)) continue;
      this.breachKeys.add(check.key);
      this.seq += 1;
      const breach: VoiceV24BudgetBreach = {
        id: `breach-${this.seq}`,
        sessionId: record.sessionId,
        toolName: record.toolName,
        kind: check.kind,
        spentMs: check.spentMs,
        budgetMs: check.budgetMs,
        overByMs: check.spentMs - check.budgetMs,
        atMs: record.endedAtMs ?? record.startedAtMs,
        callId: record.id,
        turnIndex: record.turnIndex,
      };
      this.breaches.push(breach);
      raised.push({ ...breach });
    }
    return raised;
  }

  breachesList(sessionId?: string, toolName?: string): VoiceV24BudgetBreach[] {
    return this.breaches
      .filter((b) => (sessionId === undefined || b.sessionId === sessionId) &&
        (toolName === undefined || b.toolName === toolName))
      .map((b) => ({ ...b }));
  }

  breachCount(sessionId?: string): number {
    return this.breachesList(sessionId).length;
  }

  /**
   * Burn-down of the session tool-time budget at `atMs`,
   * from the finished calls the caller passes in (the
   * registry keeps no call history of its own).
   */
  sessionBurnDown(
    sessionId: string,
    finishedCalls: readonly VoiceV24ToolCallRecord[],
    atMs: number,
  ): VoiceV24BurnDown {
    const budgetMs = this.sessionBudgetMs(sessionId);
    const spentMs = finishedCalls
      .filter((c) => c.sessionId === sessionId && c.durationMs !== null)
      .reduce((a, c) => a + (c.durationMs as number), 0);
    const windowStart = atMs - this.opts.burnWindowMs;
    const windowMs = finishedCalls
      .filter((c) => c.sessionId === sessionId && c.durationMs !== null && (c.endedAtMs ?? 0) >= windowStart)
      .reduce((a, c) => a + (c.durationMs as number), 0);
    const burnRateMsPerSecond = round2V24(windowMs / (this.opts.burnWindowMs / 1000));
    const remainingMs = budgetMs - spentMs;
    let projectedExhaustionInMs: number | null = null;
    if (burnRateMsPerSecond > 0 && remainingMs > 0) {
      projectedExhaustionInMs = Math.round((remainingMs / burnRateMsPerSecond) * 1000);
    }
    return {
      budgetMs,
      spentMs,
      remainingMs,
      spentRatio: round2V24(spentMs / budgetMs),
      burnRateMsPerSecond,
      projectedExhaustionInMs,
      breached: spentMs > budgetMs,
    };
  }

  /** Burn-down per tool inside one session (for the panel table). */
  perToolBurnDown(
    sessionId: string,
    finishedCalls: readonly VoiceV24ToolCallRecord[],
  ): { toolName: string; burn: VoiceV24BurnDown }[] {
    const byTool = new Map<string, VoiceV24ToolCallRecord[]>();
    for (const call of finishedCalls) {
      if (call.sessionId !== sessionId) continue;
      const list = byTool.get(call.toolName) ?? [];
      list.push(call);
      byTool.set(call.toolName, list);
    }
    const out: { toolName: string; burn: VoiceV24BurnDown }[] = [];
    for (const [toolName, calls] of byTool) {
      const budget = this.getBudget(toolName);
      const spentMs = calls.reduce((a, c) => a + (c.durationMs ?? 0), 0);
      const budgetMs = budget.perSessionMs as number;
      out.push({
        toolName,
        burn: {
          budgetMs,
          spentMs,
          remainingMs: budgetMs - spentMs,
          spentRatio: round2V24(spentMs / budgetMs),
          burnRateMsPerSecond: 0,
          projectedExhaustionInMs: null,
          breached: spentMs > budgetMs,
        },
      });
    }
    return out.sort((a, b) => b.burn.spentRatio - a.burn.spentRatio);
  }

  summary(sessionId: string, finishedCalls: readonly VoiceV24ToolCallRecord[], atMs: number): string {
    const burn = this.sessionBurnDown(sessionId, finishedCalls, atMs);
    const breaches = this.breachCount(sessionId);
    return (
      `Session ${sessionId} tool-time budget: spent ${formatDurationV24(burn.spentMs)} of ` +
      `${formatDurationV24(burn.budgetMs)} (${Math.round(burn.spentRatio * 100)}%), ` +
      `${formatDurationV24(Math.max(0, burn.remainingMs))} left, ` +
      `burning ${burn.burnRateMsPerSecond}ms/s` +
      (burn.projectedExhaustionInMs === null
        ? ''
        : `, exhausted in ${formatDurationV24(burn.projectedExhaustionInMs)} at this rate`) +
      `, ${breaches} breaches.`
    );
  }

  reset(): void {
    this.budgets.clear();
    this.breaches.length = 0;
    this.breachKeys.clear();
    this.sessionBudgets.clear();
    this.seq = 0;
  }
}

/** Clamp helper re-exported for callers that only import this module. */
export { clampV24 };
