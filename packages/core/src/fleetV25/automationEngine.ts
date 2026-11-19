/**
 * Scheduler engine v2 — drives fleet v25 schedules (v1.38, Đội T6).
 *
 * The engine turns schedules into runs. The host calls `tick(nowMs)`
 * on its own timer (or manually); the engine finds due schedules,
 * evaluates their run conditions, dispatches the ones that may run,
 * records the run in the ledger, and arms retries when a run fails.
 * The engine itself never runs an automation — dispatch is a callback
 * the host provides (`FleetV25DispatchFn`), so the engine stays pure
 * and testable with a fake dispatcher, and the host keeps control of
 * what "running an automation" actually does (agent loop, sandbox,
 * dry-run...).
 *
 * Concepts:
 * - `tick` — one pass: due schedules (from the registry) in fire-time
 *   order, up to `maxConcurrent` dispatches per tick. Each due
 *   schedule either fires (dispatch + record), is skipped (a condition
 *   failed — recorded as a `skipped-condition` run so the skip is
 *   visible in history), or is deferred (a retry is already pending
 *   for it, or the concurrency cap is hit — it stays due for the
 *   next tick).
 * - Retries: when a dispatched run finishes `failed` and the
 *   schedule's retry policy allows another attempt, the engine arms
 *   the retry (via the registry) and the retry fires as a new attempt
 *   in the same group when its backoff elapses. The dispatcher
 *   returns the outcome — the engine does not guess it.
 * - `tickDryRun` — the same evaluation with no dispatch and no
 *   writes: what *would* happen at `nowMs` (due list, condition
 *   results, would-fire / would-skip). Operators use it to preview a
 *   schedule change before enabling it.
 * - Concurrency: `maxConcurrent` caps dispatches per tick (default
 *   5). A tick never dispatches the same schedule twice — a schedule
 *   whose run is still in flight is not due again until its next
 *   fire time arrives (the registry advances `nextRunAtMs` on start).
 * - Safety: the engine never throws on a bad schedule — a schedule
 *   that fails validation at tick time is recorded as a failed run
 *   with the error, and the tick continues with the next schedule.
 */

import type { FleetV25AuditLog } from './auditLog';
import type { FleetV25ScheduleRegistry } from './schedules';
import {
  evaluateFleetV25Conditions,
  fleetV25ConditionsPassed,
  type FleetV25ConditionResult,
  type FleetV25ScheduledOutcome,
} from './schedules';
import type { FleetV25ScheduledRunLedger } from './scheduledRuns';
import type { FleetV25Schedule } from './schedules';

/** What the host's dispatcher returns after running an automation. */
export interface FleetV25DispatchResult {
  /**
   * Outcome of the run. The engine only accepts `completed`,
   * `failed` or `cancelled` — `running` / `skipped-condition` from
   * a dispatcher are treated as a failure (bad dispatcher) at
   * runtime, so the type stays wide on purpose.
   */
  outcome: FleetV25ScheduledOutcome;
  /** Error message when failed (null otherwise). */
  error?: string | null;
}

/** One dispatch job: everything the host needs to run an automation. */
export interface FleetV25DispatchJob {
  /** Run id (also the group id for the first attempt). */
  runId: string;
  /** Group id (shared with retries of this logical run). */
  groupId: string;
  /** Attempt number (1 = first fire). */
  attempt: number;
  /** Schedule that fired. */
  scheduleId: string;
  /** Automation the schedule drives. */
  automationId: string;
  /** Owner of the schedule. */
  owner: string;
  /** Whether this is a retry (attempt > 1). */
  isRetry: boolean;
  /** Per-condition results that gated this dispatch. */
  conditionResults: FleetV25ConditionResult[];
}

/** The host's dispatcher: actually runs the automation for a job. */
export type FleetV25DispatchFn = (job: FleetV25DispatchJob) => Promise<FleetV25DispatchResult>;

/** Options for the engine. */
export interface FleetV25EngineOptions {
  /** Max dispatches per tick (default 5, min 1, max 100). */
  maxConcurrent?: number;
  /** How long a run may stay in flight before it counts as stuck (ms, default 30 min). */
  stuckAfterMs?: number;
  /** Optional audit log: ticks append one entry per dispatch/skip/failure. */
  auditLog?: FleetV25AuditLog | null;
  /** Actor id recorded in audit entries (default `engine`). */
  auditActorId?: string;
}

/** One schedule's fate in a tick (for the tick report). */
export interface FleetV25TickDecision {
  scheduleId: string;
  automationId: string;
  /** `fired` (dispatched), `skipped` (condition failed), `deferred` (cap hit / retry pending). */
  decision: 'fired' | 'skipped' | 'deferred' | 'failed';
  trigger: 'schedule' | 'retry';
  runId: string | null;
  attempt: number;
  conditionResults: FleetV25ConditionResult[];
  outcome: FleetV25ScheduledOutcome | null;
  error: string | null;
}

/** Report of one tick. */
export interface FleetV25TickReport {
  atMs: number;
  due: number;
  fired: number;
  skipped: number;
  deferred: number;
  failed: number;
  completed: number;
  decisions: FleetV25TickDecision[];
  stuckRuns: number;
}

/** One schedule's fate in a dry-run tick (no writes, no dispatch). */
export interface FleetV25DryRunDecision {
  scheduleId: string;
  automationId: string;
  /** What would happen: fire, skip, or defer. */
  would: 'fire' | 'skip' | 'defer';
  trigger: 'schedule' | 'retry';
  conditionResults: FleetV25ConditionResult[];
  nextRunAtMs: number | null;
}

/** Report of a dry-run tick. */
export interface FleetV25DryRunReport {
  atMs: number;
  due: number;
  wouldFire: number;
  wouldSkip: number;
  wouldDefer: number;
  decisions: FleetV25DryRunDecision[];
}

import type { FleetV24AutomationStatus } from '../fleetV24/automationDashboard';

/** The scheduler engine (holds registry + ledger, host drives ticks). */
export class FleetV25AutomationEngine {
  private readonly registry: FleetV25ScheduleRegistry;
  private readonly ledger: FleetV25ScheduledRunLedger;
  private readonly maxConcurrent: number;
  private readonly stuckAfterMs: number;
  private readonly auditLog: FleetV25AuditLog | null;
  private readonly auditActorId: string;
  private runSeq = 1;

  constructor(
    registry: FleetV25ScheduleRegistry,
    ledger: FleetV25ScheduledRunLedger,
    options: FleetV25EngineOptions = {},
  ) {
    this.registry = registry;
    this.ledger = ledger;
    const max = options.maxConcurrent ?? 5;
    this.maxConcurrent = Math.min(100, Math.max(1, Math.floor(max)));
    this.stuckAfterMs = options.stuckAfterMs ?? 30 * 60 * 1000;
    this.auditLog = options.auditLog ?? null;
    this.auditActorId = options.auditActorId?.trim() ? options.auditActorId.trim() : 'engine';
  }

  /** Max dispatches per tick (as configured). */
  get concurrency(): number {
    return this.maxConcurrent;
  }

  /**
   * Evaluate what would happen at `nowMs` without dispatching or
   * writing anything. Safe to call as often as the UI wants.
   */
  tickDryRun(nowMs: number, tagStatuses?: Record<string, FleetV24AutomationStatus[]>): FleetV25DryRunReport {
    const due = this.registry.dueSchedules(nowMs);
    const decisions: FleetV25DryRunDecision[] = [];
    let fired = 0;
    for (const schedule of due) {
      const isRetry = schedule.retryAtMs !== null && schedule.retryAtMs <= nowMs;
      const ctx = this.conditionContext(schedule, nowMs, tagStatuses);
      const results = evaluateFleetV25Conditions(schedule.conditions, ctx);
      if (!fleetV25ConditionsPassed(results)) {
        decisions.push({
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          would: 'skip',
          trigger: isRetry ? 'retry' : 'schedule',
          conditionResults: results,
          nextRunAtMs: schedule.nextRunAtMs,
        });
        continue;
      }
      if (fired >= this.maxConcurrent) {
        decisions.push({
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          would: 'defer',
          trigger: isRetry ? 'retry' : 'schedule',
          conditionResults: results,
          nextRunAtMs: schedule.nextRunAtMs,
        });
        continue;
      }
      fired += 1;
      decisions.push({
        scheduleId: schedule.id,
        automationId: schedule.automationId,
        would: 'fire',
        trigger: isRetry ? 'retry' : 'schedule',
        conditionResults: results,
        nextRunAtMs: schedule.nextRunAtMs,
      });
    }
    return {
      atMs: nowMs,
      due: due.length,
      wouldFire: decisions.filter((d) => d.would === 'fire').length,
      wouldSkip: decisions.filter((d) => d.would === 'skip').length,
      wouldDefer: decisions.filter((d) => d.would === 'defer').length,
      decisions,
    };
  }

  /**
   * One tick: dispatch due schedules through `dispatch`, record runs,
   * arm retries on failure. A dispatcher throw is recorded as a
   * failed run (with the error) — never as a tick crash.
   */
  async tick(
    nowMs: number,
    dispatch: FleetV25DispatchFn,
    tagStatuses?: Record<string, FleetV24AutomationStatus[]>,
  ): Promise<FleetV25TickReport> {
    const due = this.registry.dueSchedules(nowMs);
    const decisions: FleetV25TickDecision[] = [];
    let fired = 0;
    let completed = 0;
    let failed = 0;
    for (const schedule of due) {
      const isRetry = schedule.retryAtMs !== null && schedule.retryAtMs <= nowMs;
      const attempt = isRetry ? schedule.retryAttempt + 1 : 1;
      const ctx = this.conditionContext(schedule, nowMs, tagStatuses);
      const results = evaluateFleetV25Conditions(schedule.conditions, ctx);
      if (!fleetV25ConditionsPassed(results)) {
        // Skipped: record a skipped run so the skip is visible, then
        // advance the schedule (a skip is not a failure).
        const runId = this.nextRunId(schedule.id);
        this.ledger.start(
          {
            id: runId,
            scheduleId: schedule.id,
            automationId: schedule.automationId,
            owner: schedule.owner,
            trigger: isRetry ? 'retry' : 'schedule',
            conditionResults: results,
          },
          nowMs,
        );
        this.ledger.finish(runId, 'skipped-condition', nowMs);
        this.registry.recordRunOutcome(schedule.id, 'skipped-condition', nowMs, attempt);
        this.audit('schedule.skip', schedule, 'allowed',
          `Schedule "${schedule.id}" skipped: ${results.filter((r) => !r.passed).map((r) => r.detail).join(' ')}`);
        decisions.push({
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          decision: 'skipped',
          trigger: isRetry ? 'retry' : 'schedule',
          runId,
          attempt,
          conditionResults: results,
          outcome: 'skipped-condition',
          error: null,
        });
        continue;
      }
      if (fired >= this.maxConcurrent) {
        decisions.push({
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          decision: 'deferred',
          trigger: isRetry ? 'retry' : 'schedule',
          runId: null,
          attempt,
          conditionResults: results,
          outcome: null,
          error: 'Concurrency cap reached for this tick.',
        });
        continue;
      }
      fired += 1;
      const runId = this.nextRunId(schedule.id);
      const groupId = isRetry ? this.groupIdForRetry(schedule.id) : runId;
      const job: FleetV25DispatchJob = {
        runId,
        groupId,
        attempt,
        scheduleId: schedule.id,
        automationId: schedule.automationId,
        owner: schedule.owner,
        isRetry,
        conditionResults: results,
      };
      this.ledger.start(
        {
          id: runId,
          groupId,
          attempt,
          scheduleId: schedule.id,
          automationId: schedule.automationId,
          owner: schedule.owner,
          trigger: isRetry ? 'retry' : 'schedule',
          conditionResults: results,
        },
        nowMs,
      );
      this.registry.recordRunStart(schedule.id, nowMs, isRetry);
      let outcome: FleetV25ScheduledOutcome;
      let error: string | null = null;
      try {
        const result = await dispatch(job);
        outcome = result.outcome;
        error = result.error?.trim() ? result.error.trim() : null;
        if (outcome === 'running' || outcome === 'skipped-condition') {
          throw new Error(`Dispatcher returned invalid outcome "${outcome}".`);
        }
      } catch (err) {
        outcome = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }
      this.ledger.finish(runId, outcome, nowMs, error);
      this.registry.recordRunOutcome(schedule.id, outcome, nowMs, attempt);
      if (outcome === 'completed') {
        completed += 1;
        this.audit('schedule.run', schedule, 'success',
          `Schedule "${schedule.id}" run ${runId} completed (attempt ${attempt}).`);
      } else {
        failed += 1;
        this.audit('schedule.run', schedule, 'failure',
          `Schedule "${schedule.id}" run ${runId} failed (attempt ${attempt}): ${error ?? 'unknown error'}.`);
      }
      decisions.push({
        scheduleId: schedule.id,
        automationId: schedule.automationId,
        decision: outcome === 'failed' ? 'failed' : 'fired',
        trigger: isRetry ? 'retry' : 'schedule',
        runId,
        attempt,
        conditionResults: results,
        outcome,
        error,
      });
    }
    return {
      atMs: nowMs,
      due: due.length,
      fired,
      skipped: decisions.filter((d) => d.decision === 'skipped').length,
      deferred: decisions.filter((d) => d.decision === 'deferred').length,
      failed,
      completed,
      decisions,
      stuckRuns: this.ledger.stuckRuns(nowMs, this.stuckAfterMs).length,
    };
  }

  /** Runs currently stuck in flight (for the dashboard). */
  stuckRuns(nowMs: number): ReturnType<FleetV25ScheduledRunLedger['stuckRuns']> {
    return this.ledger.stuckRuns(nowMs, this.stuckAfterMs);
  }

  private conditionContext(
    schedule: FleetV25Schedule,
    nowMs: number,
    tagStatuses?: Record<string, FleetV24AutomationStatus[]>,
  ): import('./schedules').FleetV25ConditionContext {
    return {
      lastOutcome: schedule.lastOutcome,
      runsToday: this.ledger.runsToday(schedule.id, nowMs),
      lastFinishedAtMs: schedule.lastFinishedAtMs,
      tagStatuses: tagStatuses ?? {},
      nowMs,
    };
  }

  private nextRunId(scheduleId: string): string {
    const id = `run-${scheduleId}-${this.runSeq}`;
    this.runSeq += 1;
    return id;
  }

  /** Group id for a retry: the first attempt's group id of the latest chain. */
  private groupIdForRetry(scheduleId: string): string {
    const runs = this.ledger.forSchedule(scheduleId, 50);
    // The latest chain's first attempt is the last attempt-1 run.
    const chainFirst = [...runs].reverse().filter((r) => r.attempt === 1).pop();
    return chainFirst?.groupId ?? `run-${scheduleId}-1`;
  }

  private audit(
    action: string,
    schedule: FleetV25Schedule,
    result: 'success' | 'failure' | 'allowed',
    detail: string,
  ): void {
    if (!this.auditLog) return;
    try {
      this.auditLog.append(
        {
          actorId: this.auditActorId,
          actorRole: null,
          action,
          resourceType: 'schedule',
          resourceId: schedule.id,
          result,
          detail,
        },
        Date.now(),
      );
    } catch {
      // Audit must never break a tick.
    }
  }
}

/** Create a scheduler engine over a registry + ledger. */
export function createFleetV25AutomationEngine(
  registry: FleetV25ScheduleRegistry,
  ledger: FleetV25ScheduledRunLedger,
  options?: FleetV25EngineOptions,
): FleetV25AutomationEngine {
  return new FleetV25AutomationEngine(registry, ledger, options);
}

/** One-line summary of a tick report (for logs / dashboard). */
export function summarizeFleetV25Tick(report: FleetV25TickReport): string {
  return (
    `Tick @${report.atMs}: ${report.due} due, ${report.fired} fired ` +
    `(${report.completed} completed, ${report.failed} failed), ` +
    `${report.skipped} skipped, ${report.deferred} deferred, ` +
    `${report.stuckRuns} stuck`
  );
}
