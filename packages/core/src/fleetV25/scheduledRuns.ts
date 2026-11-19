/**
 * Scheduled run history v2 — run ledger for fleet v25 schedules
 * (v1.38, Đội T6).
 *
 * The v24 run ledger records one entry per automation run; v25 extends
 * it for scheduled runs: every fire of a schedule (including retries)
 * is a run, retries share a `groupId` so the whole retry chain reads
 * as one logical run, and each run records *why* it ran (trigger),
 * *whether* its conditions passed (per-condition results), and how
 * long it took. This module is the pure core: no I/O, no timers —
 * the engine in `automationEngine.ts` starts/finishes runs, this
 * module only stores and queries them.
 *
 * Concepts:
 * - `FleetV25ScheduledRun` — one attempt: schedule + automation +
 *   owner, trigger (`schedule` / `manual` / `retry`), attempt number
 *   (1-based inside its group), start/finish, outcome, error, and
 *   the condition results that gated it.
 * - `groupId` — the id of the first attempt in a retry chain; every
 *   retry of the same logical run shares it, so `attemptsFor` can
 *   rebuild the chain and `groupOutcome` can say how the logical run
 *   ended (a later success means the group succeeded despite an
 *   early failure).
 * - `FleetV25ScheduledRunLedger` — the in-memory ledger: start /
 *   finish / query / stats / stuck detection. A run stuck in
 *   `running` past `stuckAfterMs` is reported (never auto-finished —
 *   only the engine or an operator may finish a run, so a stuck run
 *   is evidence, not something to silently rewrite).
 * - Timing stats use finished runs only; durations are computed from
 *   start/finish, never trusted from input.
 */

import type {
  FleetV25ConditionResult,
  FleetV25RunTrigger,
  FleetV25ScheduledOutcome,
} from './schedules';

/** One scheduled run (one attempt of a logical run). */
export interface FleetV25ScheduledRun {
  /** Stable id, unique in the ledger (e.g. `run-<schedule>-<n>`). */
  id: string;
  /** Group id shared by a run and its retries (first attempt's id). */
  groupId: string;
  /** Attempt number inside the group (1 = first fire). */
  attempt: number;
  /** Schedule that fired. */
  scheduleId: string;
  /** Automation the schedule drives. */
  automationId: string;
  /** Owner of the schedule. */
  owner: string;
  /** What triggered this attempt. */
  trigger: FleetV25RunTrigger;
  /** When the attempt started (epoch ms). */
  startedAtMs: number;
  /** When the attempt finished (epoch ms, null = still running). */
  finishedAtMs: number | null;
  /** Outcome (running until finished). */
  outcome: FleetV25ScheduledOutcome;
  /** Duration (ms, null until finished). */
  durationMs: number | null;
  /** Error message when failed (null otherwise). */
  error: string | null;
  /** Per-condition results that gated this attempt. */
  conditionResults: FleetV25ConditionResult[];
  /** Whether the attempt was skipped by a condition (same as outcome, for queries). */
  skippedByCondition: boolean;
}

/** Input for starting a run. */
export interface FleetV25StartScheduledRunInput {
  id: string;
  groupId?: string;
  attempt?: number;
  scheduleId: string;
  automationId: string;
  owner: string;
  trigger?: FleetV25RunTrigger;
  conditionResults?: FleetV25ConditionResult[];
}

/** Filters for querying runs (all optional; combined with AND). */
export interface FleetV25ScheduledRunQuery {
  scheduleId?: string;
  automationId?: string;
  owner?: string;
  groupId?: string;
  trigger?: FleetV25RunTrigger;
  outcome?: FleetV25ScheduledOutcome;
  fromMs?: number;
  toMs?: number;
  /** Max runs returned (newest-first when set with `newestFirst`). */
  limit?: number;
  /** When true, results come newest first (default: oldest first). */
  newestFirst?: boolean;
}

/** Timing stats over finished runs. */
export interface FleetV25RunTiming {
  /** Finished runs counted. */
  finished: number;
  /** Average duration (ms, 0 when none finished). */
  avgDurationMs: number;
  /** Longest duration (ms, 0 when none finished). */
  maxDurationMs: number;
  /** Shortest duration (ms, 0 when none finished). */
  minDurationMs: number;
}

/** Outcome of a whole retry group (logical run). */
export type FleetV25GroupOutcome = 'completed' | 'failed' | 'skipped-condition' | 'cancelled' | 'running';

/** Summary of one retry group. */
export interface FleetV25RunGroupSummary {
  groupId: string;
  scheduleId: string;
  automationId: string;
  attempts: number;
  outcome: FleetV25GroupOutcome;
  startedAtMs: number;
  finishedAtMs: number | null;
  totalDurationMs: number | null;
  lastError: string | null;
}

function cleanId(id: unknown, label: string): string {
  if (typeof id !== 'string') throw new Error(`${label} must be a string.`);
  const v = id.trim();
  if (!v) throw new Error(`${label} must not be empty.`);
  if (v.length > 128) throw new Error(`${label} must be at most 128 characters.`);
  return v;
}

/** The scheduled-run ledger (in-memory store + queries). */
export class FleetV25ScheduledRunLedger {
  private readonly runs = new Map<string, FleetV25ScheduledRun>();

  /** Number of runs in the ledger. */
  get size(): number {
    return this.runs.size;
  }

  /** Start a run. Throws on duplicate id. */
  start(input: FleetV25StartScheduledRunInput, nowMs: number): FleetV25ScheduledRun {
    const id = cleanId(input.id, 'Run id');
    if (this.runs.has(id)) throw new Error(`Run "${id}" already exists.`);
    const run: FleetV25ScheduledRun = {
      id,
      groupId: input.groupId?.trim() ? input.groupId.trim() : id,
      attempt: input.attempt !== undefined ? Math.max(1, Math.floor(input.attempt)) : 1,
      scheduleId: cleanId(input.scheduleId, 'Schedule id'),
      automationId: cleanId(input.automationId, 'Automation id'),
      owner: cleanId(input.owner, 'Owner'),
      trigger: input.trigger ?? 'schedule',
      startedAtMs: nowMs,
      finishedAtMs: null,
      outcome: 'running',
      durationMs: null,
      error: null,
      conditionResults: (input.conditionResults ?? []).map((r) => ({ ...r, condition: { ...r.condition } })),
      skippedByCondition: false,
    };
    this.runs.set(id, run);
    return this.copy(run);
  }

  /**
   * Finish a run. Returns the updated run, or null when the run does
   * not exist or is already finished. `skipped-condition` marks the
   * run as condition-skipped (no duration blame: it never executed).
   */
  finish(
    id: string,
    outcome: FleetV25ScheduledOutcome,
    nowMs: number,
    error?: string | null,
  ): FleetV25ScheduledRun | null {
    const run = this.runs.get(id.trim());
    if (!run || run.finishedAtMs !== null) return null;
    if (outcome === 'running') throw new Error('Outcome "running" is not a finish state.');
    run.finishedAtMs = nowMs;
    run.outcome = outcome;
    run.durationMs = Math.max(0, nowMs - run.startedAtMs);
    run.error = outcome === 'failed' && error?.trim() ? error.trim().slice(0, 2000) : null;
    run.skippedByCondition = outcome === 'skipped-condition';
    return this.copy(run);
  }

  /** Get a run by id (undefined when absent). Returns a copy. */
  get(id: string): FleetV25ScheduledRun | undefined {
    const r = this.runs.get(id.trim());
    return r ? this.copy(r) : undefined;
  }

  /** All runs, oldest first (copies). */
  list(): FleetV25ScheduledRun[] {
    return [...this.runs.values()]
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
      .map((r) => this.copy(r));
  }

  /** Query runs with AND filters (see `FleetV25ScheduledRunQuery`). */
  query(q: FleetV25ScheduledRunQuery = {}): FleetV25ScheduledRun[] {
    let out = this.list().filter((r) => {
      if (q.scheduleId !== undefined && r.scheduleId !== q.scheduleId) return false;
      if (q.automationId !== undefined && r.automationId !== q.automationId) return false;
      if (q.owner !== undefined && r.owner !== q.owner) return false;
      if (q.groupId !== undefined && r.groupId !== q.groupId) return false;
      if (q.trigger !== undefined && r.trigger !== q.trigger) return false;
      if (q.outcome !== undefined && r.outcome !== q.outcome) return false;
      if (q.fromMs !== undefined && r.startedAtMs < q.fromMs) return false;
      if (q.toMs !== undefined && r.startedAtMs > q.toMs) return false;
      return true;
    });
    if (q.newestFirst) out.reverse();
    if (q.limit !== undefined) {
      if (q.limit < 0) throw new Error('Run query limit must be >= 0.');
      out = out.slice(0, q.limit);
    }
    return out;
  }

  /** Runs for one schedule, newest first. */
  forSchedule(scheduleId: string, limit?: number): FleetV25ScheduledRun[] {
    return this.query({ scheduleId, newestFirst: true, limit });
  }

  /** Runs for one automation, newest first. */
  forAutomation(automationId: string, limit?: number): FleetV25ScheduledRun[] {
    return this.query({ automationId, newestFirst: true, limit });
  }

  /** All attempts of one retry group, in attempt order. */
  attemptsFor(groupId: string): FleetV25ScheduledRun[] {
    return this.query({ groupId }).sort((a, b) => a.attempt - b.attempt);
  }

  /** Runs still in flight (outcome `running`). */
  running(): FleetV25ScheduledRun[] {
    return this.query({ outcome: 'running' });
  }

  /** Runs stuck in flight longer than `stuckAfterMs` at `nowMs`. */
  stuckRuns(nowMs: number, stuckAfterMs: number): FleetV25ScheduledRun[] {
    return this.running().filter((r) => nowMs - r.startedAtMs > stuckAfterMs);
  }

  /** Counts by outcome over all runs (or a filtered subset). */
  countsByOutcome(q: FleetV25ScheduledRunQuery = {}): Record<FleetV25ScheduledOutcome, number> {
    const counts: Record<FleetV25ScheduledOutcome, number> = {
      running: 0,
      completed: 0,
      failed: 0,
      'skipped-condition': 0,
      cancelled: 0,
    };
    for (const r of this.query(q)) counts[r.outcome] += 1;
    return counts;
  }

  /** Failure rate over finished runs (0-1, 0 when nothing finished). */
  failureRate(q: FleetV25ScheduledRunQuery = {}): number {
    const counts = this.countsByOutcome(q);
    const finished = counts.completed + counts.failed + counts.cancelled;
    return finished > 0 ? counts.failed / finished : 0;
  }

  /** Timing stats over finished runs (or a filtered subset). */
  timing(q: FleetV25ScheduledRunQuery = {}): FleetV25RunTiming {
    const durations = this.query(q)
      .filter((r) => r.durationMs !== null)
      .map((r) => r.durationMs as number);
    if (durations.length === 0) {
      return { finished: 0, avgDurationMs: 0, maxDurationMs: 0, minDurationMs: 0 };
    }
    const sum = durations.reduce((a, b) => a + b, 0);
    return {
      finished: durations.length,
      avgDurationMs: Math.round(sum / durations.length),
      maxDurationMs: Math.max(...durations),
      minDurationMs: Math.min(...durations),
    };
  }

  /** Per-schedule stats: runs, outcomes, failure rate, timing. */
  statsBySchedule(scheduleId: string): {
    scheduleId: string;
    total: number;
    counts: Record<FleetV25ScheduledOutcome, number>;
    failureRate: number;
    timing: FleetV25RunTiming;
    lastOutcome: FleetV25ScheduledOutcome | null;
    lastStartedAtMs: number | null;
  } {
    const runs = this.query({ scheduleId });
    const counts = this.countsByOutcome({ scheduleId });
    const last = runs.length > 0 ? runs[runs.length - 1] : null;
    return {
      scheduleId,
      total: runs.length,
      counts,
      failureRate: this.failureRate({ scheduleId }),
      timing: this.timing({ scheduleId }),
      lastOutcome: last ? last.outcome : null,
      lastStartedAtMs: last ? last.startedAtMs : null,
    };
  }

  /** Runs started today (UTC day) for one schedule — for the max-runs-per-day condition. */
  runsToday(scheduleId: string, nowMs: number): number {
    const dayStart = Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
    );
    return this.query({ scheduleId, fromMs: dayStart, toMs: nowMs }).length;
  }

  /** Summaries of every retry group (one row per logical run). */
  groupSummaries(): FleetV25RunGroupSummary[] {
    const groups = new Map<string, FleetV25ScheduledRun[]>();
    for (const r of this.list()) {
      const list = groups.get(r.groupId) ?? [];
      list.push(r);
      groups.set(r.groupId, list);
    }
    const out: FleetV25RunGroupSummary[] = [];
    for (const [groupId, attempts] of groups) {
      attempts.sort((a, b) => a.attempt - b.attempt);
      const first = attempts[0];
      const last = attempts[attempts.length - 1];
      let outcome: FleetV25GroupOutcome;
      if (attempts.some((a) => a.outcome === 'running')) outcome = 'running';
      else if (last.outcome === 'completed') outcome = 'completed';
      else if (last.outcome === 'skipped-condition') outcome = 'skipped-condition';
      else if (last.outcome === 'cancelled') outcome = 'cancelled';
      else outcome = 'failed';
      const finished = attempts.filter((a) => a.finishedAtMs !== null);
      out.push({
        groupId,
        scheduleId: first.scheduleId,
        automationId: first.automationId,
        attempts: attempts.length,
        outcome,
        startedAtMs: first.startedAtMs,
        finishedAtMs: finished.length === attempts.length
          ? Math.max(...finished.map((a) => a.finishedAtMs as number))
          : null,
        totalDurationMs: finished.length > 0
          ? finished.reduce((n, a) => n + (a.durationMs ?? 0), 0)
          : null,
        lastError: [...attempts].reverse().find((a) => a.error)?.error ?? null,
      });
    }
    return out.sort((a, b) => b.startedAtMs - a.startedAtMs || a.groupId.localeCompare(b.groupId));
  }

  /** Summary of one retry group (null when the group does not exist). */
  groupSummary(groupId: string): FleetV25RunGroupSummary | null {
    return this.groupSummaries().find((g) => g.groupId === groupId) ?? null;
  }

  private copy(r: FleetV25ScheduledRun): FleetV25ScheduledRun {
    return {
      ...r,
      conditionResults: r.conditionResults.map((cr) => ({ ...cr, condition: { ...cr.condition } })),
    };
  }
}

/** Create an empty scheduled-run ledger. */
export function createFleetV25ScheduledRunLedger(): FleetV25ScheduledRunLedger {
  return new FleetV25ScheduledRunLedger();
}
