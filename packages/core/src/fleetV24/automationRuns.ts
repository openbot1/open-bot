/**
 * Automation run ledger v24 (v1.37, Đội T6).
 *
 * The dashboard (`automationDashboard.ts`) shows *current* status; this
 * module keeps the *history* behind it: every run of every automation,
 * when it started, when it finished, and how it ended. The two modules
 * are kept separate on purpose — the registry is cheap to snapshot for
 * the UI, while the ledger can grow long and is queried by time window,
 * automation, tag or outcome.
 *
 * Concepts:
 * - `FleetV24Run` — one run: automation id, owner + tags copied at start
 *   time (so a later retag does not rewrite history), start/finish
 *   timestamps, outcome (`running` while in flight, then `completed` /
 *   `failed` / `stopped` / `cancelled`), duration, and an optional error
 *   message. A run stopped by a stop hook ends as `stopped` and carries
 *   the stop-hook feedback id so the dashboard can link run → feedback.
 * - `FleetV24RunLedger` — append-only store with a cap. Queries: by
 *   automation, by tag, by owner, by outcome, by time window, recent
 *   runs, longest runs, failure rate per automation/tag, and the
 *   "stuck" detector (runs still `running` past a max-age threshold).
 * - Failure-rate helpers feed the dashboard's per-tag/per-owner stats
 *   with real numbers instead of the registry's lifetime counters.
 *
 * Runs are plain JSON-able records; the ledger never runs anything.
 */

/** How a run ended. `running` = still in flight. */
export type FleetV24RunOutcome = 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';

/** One automation run. */
export interface FleetV24Run {
  /** Run id, unique inside the ledger (e.g. `run-20261118-0001`). */
  id: string;
  /** Automation this run belongs to. */
  automationId: string;
  /** Owner copied from the automation at start time. */
  owner: string;
  /** Tags copied from the automation at start time. */
  tags: string[];
  /** When the run started (epoch ms). */
  startedAtMs: number;
  /** When the run finished (epoch ms, null = still running). */
  finishedAtMs: number | null;
  /** Current outcome. */
  outcome: FleetV24RunOutcome;
  /** Duration in ms (null while running). */
  durationMs: number | null;
  /** Error message when the run failed, null otherwise. */
  error: string | null;
  /** Stop-hook feedback id when a stop hook ended this run, else null. */
  stopHookFeedbackId: string | null;
  /** Optional trigger label (`schedule`, `manual`, `webhook`, ...). */
  trigger: string | null;
}

/** Input for starting a run. */
export interface FleetV24StartRunInput {
  id: string;
  automationId: string;
  owner: string;
  tags?: string[];
  trigger?: string | null;
}

/** Filter for querying the ledger. Every field is optional (AND-combined). */
export interface FleetV24RunQuery {
  automationId?: string;
  owner?: string;
  tag?: string;
  outcome?: FleetV24RunOutcome;
  /** Only runs started at or after this instant. */
  fromMs?: number;
  /** Only runs started before this instant. */
  toMs?: number;
  /** Only runs that finished with an error message containing this text. */
  errorContains?: string;
}

/** Failure-rate summary for one automation or tag. */
export interface FleetV24FailureRate {
  /** Automation id or tag the rate is about. */
  key: string;
  /** Finished runs in the window. */
  finished: number;
  /** Failed runs in the window. */
  failed: number;
  /** Stopped runs in the window. */
  stopped: number;
  /** failed / finished (0 when nothing finished). */
  failureRate: number;
  /** (failed + stopped) / finished — the "did not complete cleanly" rate. */
  notCleanRate: number;
}

/** Timing summary for a set of finished runs. */
export interface FleetV24RunTiming {
  /** Finished runs counted. */
  count: number;
  /** Mean duration in ms (0 when none). */
  meanMs: number;
  /** Median duration in ms (0 when none). */
  medianMs: number;
  /** Slowest duration in ms (0 when none). */
  maxMs: number;
  /** Fastest duration in ms (0 when none). */
  minMs: number;
  /** 95th percentile duration in ms (0 when none). */
  p95Ms: number;
}

/** Maximum runs kept per ledger (oldest dropped first). */
export const FLEET_V24_RUN_LEDGER_CAP = 5000;

/** Maximum run id length. */
export const FLEET_V24_RUN_ID_MAX = 128;

function isFinishedOutcome(outcome: FleetV24RunOutcome): boolean {
  return outcome === 'completed' || outcome === 'failed' || outcome === 'stopped' || outcome === 'cancelled';
}

/** Validate a start-run input; returns the first problem, or null. */
export function validateFleetV24StartRunInput(input: FleetV24StartRunInput): string | null {
  if (input.id.trim().length === 0) return 'Run id must not be empty.';
  if (input.id.trim().length > FLEET_V24_RUN_ID_MAX) return 'Run id must be at most 128 characters.';
  if (/\s/.test(input.id.trim())) return 'Run id must not contain whitespace.';
  if (input.automationId.trim().length === 0) return 'Automation id must not be empty.';
  if (input.owner.trim().length === 0) return 'Owner must not be empty.';
  return null;
}

/** Build a fresh run record (status `running`). Throws on invalid input. */
export function createFleetV24Run(
  input: FleetV24StartRunInput,
  nowMs: number,
): FleetV24Run {
  const error = validateFleetV24StartRunInput(input);
  if (error !== null) throw new Error(`Invalid run: ${error}`);
  return {
    id: input.id.trim(),
    automationId: input.automationId.trim(),
    owner: input.owner.trim(),
    tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))].sort(),
    startedAtMs: nowMs,
    finishedAtMs: null,
    outcome: 'running',
    durationMs: null,
    error: null,
    stopHookFeedbackId: null,
    trigger: input.trigger?.trim() ? input.trigger.trim() : null,
  };
}

/** Compute a timing summary over finished runs. */
export function summarizeFleetV24RunTiming(runs: readonly FleetV24Run[]): FleetV24RunTiming {
  const durations = runs
    .filter((r) => r.durationMs !== null)
    .map((r) => r.durationMs as number)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return { count: 0, meanMs: 0, medianMs: 0, maxMs: 0, minMs: 0, p95Ms: 0 };
  }
  const sum = durations.reduce((acc, d) => acc + d, 0);
  const mid = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
  const p95Index = Math.min(durations.length - 1, Math.floor(durations.length * 0.95));
  return {
    count: durations.length,
    meanMs: Math.round(sum / durations.length),
    medianMs: Math.round(median),
    maxMs: durations[durations.length - 1],
    minMs: durations[0],
    p95Ms: durations[p95Index],
  };
}

/** Compute a failure rate over finished runs. */
export function failureRateFleetV24Runs(
  key: string,
  runs: readonly FleetV24Run[],
): FleetV24FailureRate {
  const finished = runs.filter((r) => isFinishedOutcome(r.outcome));
  const failed = finished.filter((r) => r.outcome === 'failed').length;
  const stopped = finished.filter((r) => r.outcome === 'stopped').length;
  return {
    key,
    finished: finished.length,
    failed,
    stopped,
    failureRate: finished.length > 0 ? failed / finished.length : 0,
    notCleanRate: finished.length > 0 ? (failed + stopped) / finished.length : 0,
  };
}

/**
 * Append-only ledger of automation runs.
 *
 * The ledger is the history the dashboard groups and filters: an operator
 * asks "show me the failed runs of tag `nightly` in the last 24h" and gets
 * runs, not just counters. The host is expected to call `finish` when a
 * run ends; a run left `running` forever is surfaced by `stuckRuns`.
 */
export class FleetV24RunLedger {
  private runs: FleetV24Run[] = [];
  private readonly byId = new Map<string, FleetV24Run>();

  /** Number of runs stored. */
  get size(): number {
    return this.runs.length;
  }

  /** All runs, oldest first. */
  list(): FleetV24Run[] {
    return [...this.runs];
  }

  /** Look one run up by id. */
  get(id: string): FleetV24Run | undefined {
    return this.byId.get(id.trim());
  }

  /** Start a run. Throws on invalid input or duplicate id. */
  start(input: FleetV24StartRunInput, nowMs: number): FleetV24Run {
    const run = createFleetV24Run(input, nowMs);
    if (this.byId.has(run.id)) {
      throw new Error(`Run "${run.id}" already exists in the ledger.`);
    }
    this.runs.push(run);
    this.byId.set(run.id, run);
    if (this.runs.length > FLEET_V24_RUN_LEDGER_CAP) {
      const dropped = this.runs.splice(0, this.runs.length - FLEET_V24_RUN_LEDGER_CAP);
      for (const d of dropped) this.byId.delete(d.id);
    }
    return run;
  }

  /**
   * Finish a run. Returns false when the run is unknown or already
   * finished. `stopHookFeedbackId` links a stop-hook stop to its
   * feedback record.
   */
  finish(
    id: string,
    outcome: Exclude<FleetV24RunOutcome, 'running'>,
    nowMs: number,
    error?: string | null,
    stopHookFeedbackId?: string | null,
  ): FleetV24Run | null {
    const run = this.byId.get(id.trim());
    if (!run) return null;
    if (run.outcome !== 'running') return null;
    if (nowMs < run.startedAtMs) {
      throw new Error('Run cannot finish before it started.');
    }
    run.outcome = outcome;
    run.finishedAtMs = nowMs;
    run.durationMs = nowMs - run.startedAtMs;
    run.error = outcome === 'failed' && error?.trim() ? error.trim().slice(0, 2000) : null;
    run.stopHookFeedbackId =
      outcome === 'stopped' && stopHookFeedbackId?.trim()
        ? stopHookFeedbackId.trim()
        : null;
    return run;
  }

  /** Runs still in flight. */
  running(): FleetV24Run[] {
    return this.runs.filter((r) => r.outcome === 'running');
  }

  /** Runs still in flight that started more than `maxAgeMs` ago. */
  stuckRuns(nowMs: number, maxAgeMs: number): FleetV24Run[] {
    return this.runs.filter(
      (r) => r.outcome === 'running' && nowMs - r.startedAtMs > maxAgeMs,
    );
  }

  /** Query runs with an AND-combined filter, newest first. */
  query(query: FleetV24RunQuery, limit = 100): FleetV24Run[] {
    const tag = query.tag?.trim().toLowerCase();
    const owner = query.owner?.trim();
    const automationId = query.automationId?.trim();
    const errorNeedle = query.errorContains?.trim().toLowerCase();
    return this.runs
      .filter((r) => {
        if (automationId && r.automationId !== automationId) return false;
        if (owner && r.owner !== owner) return false;
        if (tag && !r.tags.includes(tag)) return false;
        if (query.outcome && r.outcome !== query.outcome) return false;
        if (query.fromMs !== undefined && r.startedAtMs < query.fromMs) return false;
        if (query.toMs !== undefined && r.startedAtMs >= query.toMs) return false;
        if (errorNeedle && !(r.error ?? '').toLowerCase().includes(errorNeedle)) return false;
        return true;
      })
      .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, limit));
  }

  /** Most recent runs, newest first. */
  recent(limit = 20): FleetV24Run[] {
    return [...this.runs]
      .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, limit));
  }

  /** Runs of one automation, newest first. */
  forAutomation(automationId: string, limit = 50): FleetV24Run[] {
    return this.query({ automationId }, limit);
  }

  /** Runs carrying one tag, newest first. */
  forTag(tag: string, limit = 100): FleetV24Run[] {
    return this.query({ tag }, limit);
  }

  /** Failed runs, newest first. */
  failed(limit = 50): FleetV24Run[] {
    return this.query({ outcome: 'failed' }, limit);
  }

  /** Runs stopped by a stop hook, newest first. */
  stoppedByHook(limit = 50): FleetV24Run[] {
    return this.runs
      .filter((r) => r.outcome === 'stopped' && r.stopHookFeedbackId !== null)
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, Math.max(0, limit));
  }

  /** Longest finished runs, slowest first. */
  longest(limit = 20): FleetV24Run[] {
    return this.runs
      .filter((r) => r.durationMs !== null)
      .sort((a, b) => (b.durationMs as number) - (a.durationMs as number))
      .slice(0, Math.max(0, limit));
  }

  /** Failure rate for one automation over its stored runs. */
  failureRateForAutomation(automationId: string): FleetV24FailureRate {
    return failureRateFleetV24Runs(
      automationId.trim(),
      this.runs.filter((r) => r.automationId === automationId.trim()),
    );
  }

  /** Failure rate for one tag over its stored runs. */
  failureRateForTag(tag: string): FleetV24FailureRate {
    const normalized = tag.trim().toLowerCase();
    return failureRateFleetV24Runs(
      normalized,
      this.runs.filter((r) => r.tags.includes(normalized)),
    );
  }

  /** Failure rates for every automation that has finished runs. */
  failureRatesByAutomation(): FleetV24FailureRate[] {
    const byAutomation = new Map<string, FleetV24Run[]>();
    for (const r of this.runs) {
      const bucket = byAutomation.get(r.automationId) ?? [];
      bucket.push(r);
      byAutomation.set(r.automationId, bucket);
    }
    return [...byAutomation.entries()]
      .map(([key, runs]) => failureRateFleetV24Runs(key, runs))
      .filter((f) => f.finished > 0)
      .sort((a, b) => b.failureRate - a.failureRate || b.finished - a.finished);
  }

  /** Timing summary for one automation's finished runs. */
  timingForAutomation(automationId: string): FleetV24RunTiming {
    return summarizeFleetV24RunTiming(
      this.runs.filter((r) => r.automationId === automationId.trim()),
    );
  }

  /** Timing summary for one tag's finished runs. */
  timingForTag(tag: string): FleetV24RunTiming {
    const normalized = tag.trim().toLowerCase();
    return summarizeFleetV24RunTiming(this.runs.filter((r) => r.tags.includes(normalized)));
  }

  /** Counts by outcome across the whole ledger. */
  countsByOutcome(): Record<FleetV24RunOutcome, number> {
    const counts: Record<FleetV24RunOutcome, number> = {
      running: 0,
      completed: 0,
      failed: 0,
      stopped: 0,
      cancelled: 0,
    };
    for (const r of this.runs) counts[r.outcome] += 1;
    return counts;
  }
}

/** Create an empty run ledger. */
export function createFleetV24RunLedger(): FleetV24RunLedger {
  return new FleetV24RunLedger();
}
