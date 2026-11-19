/**
 * Scheduled automations v2 — schedules with cron/interval/one-shot,
 * run conditions and retry policy (v1.38, Đội T6).
 *
 * Fleet v25 upgrades the v24 automation dashboard's flat `schedule`
 * string into a real scheduler: a schedule knows *when* it fires
 * (cron expression, fixed interval, or one-shot), *whether* it should
 * fire (run conditions evaluated at fire time), and *what to do when
 * it fails* (retry policy with exponential backoff). This module is
 * the pure core: no I/O, no timers — the engine in
 * `automationEngine.ts` drives ticks, this module only models the
 * schedule and answers "when is the next run?" and "may it run now?".
 *
 * Concepts:
 * - `FleetV25ScheduleKind` — `cron` (5-field expression, UTC),
 *   `interval` (every N ms), `once` (a single fire time).
 * - Cron: standard 5 fields (minute hour day-of-month month
 *   day-of-week), each supporting `*`, lists, ranges and steps.
 *   Day-of-month and day-of-week combine with OR when both are
 *   restricted (Vixie cron semantics). Evaluation is in UTC so
 *   daylight-saving changes can never double-fire or skip a run; the
 *   `timezone` field is a display label only, recorded for the UI.
 * - `FleetV25RunCondition` — a gate evaluated at fire time:
 *   `previous-run-outcome` (only run when the last run ended a given
 *   way), `time-window` (only inside a UTC hour range),
 *   `max-runs-per-day` (cap runs per UTC day), `tag-status` (only
 *   when a named automation tag is in a given status — evaluated by
 *   the engine against the v24 registry), `cooldown` (only when the
 *   last run finished at least N ms ago). A schedule with no
 *   conditions always fires when due.
 * - `FleetV25RetryPolicy` — after a failed run, retry up to
 *   `maxRetries` times with exponential backoff (`backoffMs *`
 *   `backoffMultiplier^attempt`, capped at `maxBackoffMs`). Retries
 *   only happen for outcomes listed in `retryOn`.
 * - `FleetV25ScheduleRegistry` — the in-memory registry: validates
 *   every mutation, computes `nextRunAtMs` on create/update, tracks
 *   outcome counters and consecutive failures, and answers
 *   `dueSchedules(nowMs)`.
 */

import type { FleetV24AutomationStatus } from '../fleetV24/automationDashboard';

/** How a schedule fires. */
export type FleetV25ScheduleKind = 'cron' | 'interval' | 'once';

/** All schedule kinds, in UI display order. */
export const FLEET_V25_SCHEDULE_KINDS: readonly FleetV25ScheduleKind[] = [
  'cron',
  'interval',
  'once',
];

/** Outcome of a scheduled run (shared with `scheduledRuns.ts`). */
export type FleetV25ScheduledOutcome =
  | 'completed'
  | 'failed'
  | 'skipped-condition'
  | 'cancelled'
  | 'running';

/** What triggers a scheduled run. */
export type FleetV25RunTrigger = 'schedule' | 'manual' | 'retry';

/** One parsed cron field (minute/hour/dom/month/dow). */
export interface FleetV25CronField {
  /** Sorted set of allowed values. */
  values: number[];
  /** true when the field was `*` (unrestricted). */
  unrestricted: boolean;
}

/** A parsed 5-field cron expression. */
export interface FleetV25CronExpression {
  /** Original expression text (single-spaced). */
  text: string;
  minute: FleetV25CronField;
  hour: FleetV25CronField;
  dayOfMonth: FleetV25CronField;
  month: FleetV25CronField;
  dayOfWeek: FleetV25CronField;
}

/** Result of validating a cron expression. */
export interface FleetV25CronValidation {
  valid: boolean;
  problems: string[];
  expression: FleetV25CronExpression | null;
}

const CRON_RANGES: readonly [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both mean Sunday)
];
const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

function parseCronField(raw: string, fieldIdx: number): FleetV25CronField {
  const [min, max] = CRON_RANGES[fieldIdx];
  const name = CRON_FIELD_NAMES[fieldIdx];
  const values = new Set<number>();
  if (raw === '*') {
    for (let v = min; v <= max; v++) values.add(v);
    return { values: [...values].sort((a, b) => a - b), unrestricted: true };
  }
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Cron ${name}: empty list item.`);
    let rangeText = trimmed;
    let step = 1;
    const slash = trimmed.indexOf('/');
    if (slash !== -1) {
      rangeText = trimmed.slice(0, slash);
      const stepText = trimmed.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) throw new Error(`Cron ${name}: bad step "${stepText}".`);
      step = Number(stepText);
      if (step < 1) throw new Error(`Cron ${name}: step must be >= 1.`);
    }
    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-');
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
        throw new Error(`Cron ${name}: bad range "${rangeText}".`);
      }
      lo = Number(a);
      hi = Number(b);
    } else if (/^\d+$/.test(rangeText)) {
      lo = Number(rangeText);
      hi = lo;
    } else {
      throw new Error(`Cron ${name}: bad value "${rangeText}".`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Cron ${name}: range ${lo}-${hi} outside ${min}-${max}.`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  // Day-of-week: 7 is Sunday, same as 0.
  if (fieldIdx === 4 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return { values: [...values].sort((a, b) => a - b), unrestricted: false };
}

/** Parse a 5-field cron expression. Throws on the first problem. */
export function parseFleetV25Cron(text: string): FleetV25CronExpression {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Cron expression must be a non-empty string.');
  }
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) => parseCronField(f, i));
  return {
    text: fields.join(' '),
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
  };
}

/** Validate a cron expression without throwing. */
export function validateFleetV25Cron(text: string): FleetV25CronValidation {
  try {
    return { valid: true, problems: [], expression: parseFleetV25Cron(text) };
  } catch (err) {
    return {
      valid: false,
      problems: [err instanceof Error ? err.message : String(err)],
      expression: null,
    };
  }
}

/**
 * Next fire time (epoch ms, UTC) strictly after `fromMs`. Steps
 * minute by minute (at most ~527k iterations = 1 year) — cheap for a
 * scheduler that ticks once a minute or less, and exact for the OR
 * semantics of day-of-month vs day-of-week.
 */
export function nextFleetV25CronRunMs(cron: FleetV25CronExpression, fromMs: number): number | null {
  const start = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = start + 366 * 24 * 60 * 60000;
  for (let t = start; t <= limit; t += 60000) {
    const d = new Date(t);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();
    if (!cron.minute.values.includes(minute)) continue;
    if (!cron.hour.values.includes(hour)) continue;
    if (!cron.month.values.includes(month)) continue;
    // Vixie semantics: when both dom and dow are restricted, either may match.
    const domMatch = cron.dayOfMonth.values.includes(dom);
    const dowMatch = cron.dayOfWeek.values.includes(dow);
    const domRestricted = !cron.dayOfMonth.unrestricted;
    const dowRestricted = !cron.dayOfWeek.unrestricted;
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) dayMatch = domMatch || dowMatch;
    else if (domRestricted) dayMatch = domMatch;
    else if (dowRestricted) dayMatch = dowMatch;
    else dayMatch = true;
    if (!dayMatch) continue;
    return t;
  }
  return null;
}

/** Describe a cron expression in one line (for the UI). */
export function describeFleetV25Cron(cron: FleetV25CronExpression): string {
  const at = (field: FleetV25CronField, label: string): string =>
    field.unrestricted ? `every ${label}` : `${label} ${field.values.join(',')}`;
  return (
    `Cron "${cron.text}" — ${at(cron.minute, 'minute')}, ` +
    `${at(cron.hour, 'hour')}, ${at(cron.dayOfMonth, 'day')}, ` +
    `${at(cron.month, 'month')}, ${at(cron.dayOfWeek, 'weekday')} (UTC)`
  );
}

// --- run conditions ---------------------------------------------------------

/** Kinds of run condition. */
export type FleetV25ConditionType =
  | 'previous-run-outcome'
  | 'time-window'
  | 'max-runs-per-day'
  | 'tag-status'
  | 'cooldown';

/** One run condition (data only — evaluated by `evaluateFleetV25Condition`). */
export interface FleetV25RunCondition {
  type: FleetV25ConditionType;
  /** For previous-run-outcome: the outcome(s) the last run must have had. */
  outcomes?: FleetV25ScheduledOutcome[];
  /** For time-window: start hour (UTC, 0-23, inclusive). */
  startHour?: number;
  /** For time-window: end hour (UTC, 0-23, exclusive; may wrap midnight). */
  endHour?: number;
  /** For max-runs-per-day: the cap. */
  maxRuns?: number;
  /** For tag-status: the tag to look up. */
  tag?: string;
  /** For tag-status: the status the tag's automations must have. */
  status?: FleetV24AutomationStatus;
  /** For cooldown: minimum ms since the last finished run. */
  minMsSinceLastRun?: number;
}

/** Context the engine passes when evaluating conditions. */
export interface FleetV25ConditionContext {
  /** Outcome of the schedule's last finished run (null = never ran). */
  lastOutcome: FleetV25ScheduledOutcome | null;
  /** Runs started today (UTC day) for this schedule. */
  runsToday: number;
  /** When the last run finished (epoch ms, null = never). */
  lastFinishedAtMs: number | null;
  /** Statuses of automations carrying a tag (for tag-status). */
  tagStatuses?: Record<string, FleetV24AutomationStatus[]>;
  /** The time the condition is evaluated at (epoch ms). */
  nowMs: number;
}

/** Result of evaluating one condition. */
export interface FleetV25ConditionResult {
  condition: FleetV25RunCondition;
  passed: boolean;
  /** Human-readable explanation (English; UI uses i18n keys). */
  detail: string;
}

/** Validate one condition. Returns problems (empty = valid). */
export function validateFleetV25Condition(condition: FleetV25RunCondition): string[] {
  const problems: string[] = [];
  switch (condition.type) {
    case 'previous-run-outcome':
      if (!condition.outcomes || condition.outcomes.length === 0) {
        problems.push('previous-run-outcome needs at least one outcome.');
      }
      break;
    case 'time-window': {
      const { startHour, endHour } = condition;
      if (startHour === undefined || endHour === undefined) {
        problems.push('time-window needs startHour and endHour.');
      } else {
        if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
          problems.push('time-window startHour must be an integer 0-23.');
        }
        if (!Number.isInteger(endHour) || endHour < 0 || endHour > 23) {
          problems.push('time-window endHour must be an integer 0-23.');
        }
        if (startHour === endHour) problems.push('time-window startHour must differ from endHour.');
      }
      break;
    }
    case 'max-runs-per-day':
      if (condition.maxRuns === undefined || !Number.isInteger(condition.maxRuns) || condition.maxRuns < 1) {
        problems.push('max-runs-per-day needs maxRuns, an integer >= 1.');
      }
      break;
    case 'tag-status':
      if (!condition.tag?.trim()) problems.push('tag-status needs a tag.');
      if (!condition.status) problems.push('tag-status needs a status.');
      break;
    case 'cooldown':
      if (condition.minMsSinceLastRun === undefined || condition.minMsSinceLastRun < 0) {
        problems.push('cooldown needs minMsSinceLastRun >= 0.');
      }
      break;
    default:
      problems.push(`Unknown condition type: ${String((condition as { type?: unknown }).type)}.`);
  }
  return problems;
}

/** Evaluate one condition against the context. Never throws. */
export function evaluateFleetV25Condition(
  condition: FleetV25RunCondition,
  ctx: FleetV25ConditionContext,
): FleetV25ConditionResult {
  switch (condition.type) {
    case 'previous-run-outcome': {
      const wanted = condition.outcomes ?? [];
      const passed = ctx.lastOutcome !== null && wanted.includes(ctx.lastOutcome);
      return {
        condition,
        passed,
        detail: passed
          ? `Last run outcome was "${ctx.lastOutcome}" (wanted ${wanted.join('/')}).`
          : ctx.lastOutcome === null
            ? 'No previous run yet — condition needs a previous outcome.'
            : `Last run outcome was "${ctx.lastOutcome}" (wanted ${wanted.join('/')}).`,
      };
    }
    case 'time-window': {
      const hour = new Date(ctx.nowMs).getUTCHours();
      const start = condition.startHour ?? 0;
      const end = condition.endHour ?? 0;
      const inside = start < end ? hour >= start && hour < end : hour >= start || hour < end;
      return {
        condition,
        passed: inside,
        detail: inside
          ? `UTC hour ${hour} is inside window ${start}:00-${end}:00.`
          : `UTC hour ${hour} is outside window ${start}:00-${end}:00.`,
      };
    }
    case 'max-runs-per-day': {
      const cap = condition.maxRuns ?? 1;
      const passed = ctx.runsToday < cap;
      return {
        condition,
        passed,
        detail: passed
          ? `${ctx.runsToday}/${cap} runs today — under the cap.`
          : `${ctx.runsToday}/${cap} runs today — daily cap reached.`,
      };
    }
    case 'tag-status': {
      const tag = (condition.tag ?? '').trim().toLowerCase();
      const statuses = ctx.tagStatuses?.[tag] ?? [];
      if (statuses.length === 0) {
        return { condition, passed: false, detail: `No automation carries tag "${tag}".` };
      }
      const passed = statuses.every((s) => s === condition.status);
      return {
        condition,
        passed,
        detail: passed
          ? `All ${statuses.length} automation(s) tagged "${tag}" are ${condition.status}.`
          : `Tag "${tag}" has status ${statuses.join(', ')} (wanted ${condition.status}).`,
      };
    }
    case 'cooldown': {
      const minMs = condition.minMsSinceLastRun ?? 0;
      if (ctx.lastFinishedAtMs === null) {
        return { condition, passed: true, detail: 'No previous run — no cooldown applies.' };
      }
      const elapsed = ctx.nowMs - ctx.lastFinishedAtMs;
      return {
        condition,
        passed: elapsed >= minMs,
        detail: elapsed >= minMs
          ? `Last run finished ${elapsed}ms ago (>= ${minMs}ms cooldown).`
          : `Last run finished ${elapsed}ms ago (< ${minMs}ms cooldown).`,
      };
    }
  }
}

/** Evaluate all conditions (AND). Returns per-condition results. */
export function evaluateFleetV25Conditions(
  conditions: readonly FleetV25RunCondition[],
  ctx: FleetV25ConditionContext,
): FleetV25ConditionResult[] {
  return conditions.map((c) => evaluateFleetV25Condition(c, ctx));
}

/** true when every condition passed. */
export function fleetV25ConditionsPassed(results: readonly FleetV25ConditionResult[]): boolean {
  return results.every((r) => r.passed);
}

// --- retry policy -----------------------------------------------------------

/** Retry policy for a schedule (after a failed run). */
export interface FleetV25RetryPolicy {
  /** Max retry attempts after a failure (0 = no retry). */
  maxRetries: number;
  /** Base backoff before the first retry (ms). */
  backoffMs: number;
  /** Backoff multiplier per attempt (1 = fixed delay). */
  backoffMultiplier: number;
  /** Hard cap on any single backoff delay (ms). */
  maxBackoffMs: number;
  /** Outcomes that trigger a retry (default: failed only). */
  retryOn: FleetV25ScheduledOutcome[];
}

/** Default retry policy: no retries (explicit opt-in). */
export const FLEET_V25_DEFAULT_RETRY_POLICY: FleetV25RetryPolicy = {
  maxRetries: 0,
  backoffMs: 60000,
  backoffMultiplier: 2,
  maxBackoffMs: 3600000,
  retryOn: ['failed'],
};

/** Validate a retry policy. Returns problems (empty = valid). */
export function validateFleetV25RetryPolicy(policy: FleetV25RetryPolicy): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 10) {
    problems.push('maxRetries must be an integer 0-10.');
  }
  if (policy.backoffMs < 0 || !Number.isFinite(policy.backoffMs)) {
    problems.push('backoffMs must be >= 0.');
  }
  if (policy.backoffMultiplier < 1 || !Number.isFinite(policy.backoffMultiplier)) {
    problems.push('backoffMultiplier must be >= 1.');
  }
  if (policy.maxBackoffMs < 0 || !Number.isFinite(policy.maxBackoffMs)) {
    problems.push('maxBackoffMs must be >= 0.');
  }
  if (policy.maxBackoffMs < policy.backoffMs) {
    problems.push('maxBackoffMs must be >= backoffMs.');
  }
  if (!policy.retryOn || policy.retryOn.length === 0) {
    problems.push('retryOn needs at least one outcome.');
  }
  return problems;
}

/**
 * Delay before retry attempt `attempt` (1-based): exponential
 * backoff, capped. Deterministic (no jitter) so retries are
 * reproducible in tests; the engine may add jitter on top.
 */
export function fleetV25RetryDelayMs(policy: FleetV25RetryPolicy, attempt: number): number {
  if (attempt < 1) return 0;
  const raw = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(Math.floor(raw), policy.maxBackoffMs);
}

/** true when `outcome` should trigger a retry under this policy. */
export function fleetV25ShouldRetry(
  policy: FleetV25RetryPolicy,
  outcome: FleetV25ScheduledOutcome,
  attempt: number,
): boolean {
  return attempt <= policy.maxRetries && policy.retryOn.includes(outcome);
}

// --- schedule record + registry ---------------------------------------------

/** One scheduled automation (v2). */
export interface FleetV25Schedule {
  /** Stable id, unique in the registry. */
  id: string;
  /** Automation (v24 dashboard id) this schedule drives. */
  automationId: string;
  /** Owner (user/team id) responsible for the schedule. */
  owner: string;
  /** Human name shown in the UI. */
  name: string;
  /** How the schedule fires. */
  kind: FleetV25ScheduleKind;
  /** Cron expression (kind `cron` only). */
  cron: string | null;
  /** Fixed interval (kind `interval` only, ms). */
  intervalMs: number | null;
  /** Single fire time (kind `once` only, epoch ms). */
  runAtMs: number | null;
  /** Timezone label for display (evaluation is UTC). */
  timezone: string;
  /** Run conditions (all must pass at fire time). */
  conditions: FleetV25RunCondition[];
  /** Retry policy after a failed run. */
  retry: FleetV25RetryPolicy;
  /** Whether the schedule is live (disabled schedules never fire). */
  enabled: boolean;
  /** Whether the schedule is paused (paused schedules never fire). */
  paused: boolean;
  /** When the schedule was created (epoch ms). */
  createdAtMs: number;
  /** When any field last changed (epoch ms). */
  updatedAtMs: number;
  /** Next fire time (epoch ms, null = no future fire). */
  nextRunAtMs: number | null;
  /** When the last run started (epoch ms, null = never). */
  lastRunAtMs: number | null;
  /** When the last run finished (epoch ms, null = never). */
  lastFinishedAtMs: number | null;
  /** Outcome of the last finished run (null = never finished). */
  lastOutcome: FleetV25ScheduledOutcome | null;
  /** Total runs started (incl. retries). */
  runCount: number;
  /** Runs that finished successfully. */
  successCount: number;
  /** Runs that finished with failure. */
  failureCount: number;
  /** Runs skipped because a condition failed. */
  skippedCount: number;
  /** Consecutive failures (reset on success). */
  consecutiveFailures: number;
  /** Pending retry: fire time of the next retry (null = none). */
  retryAtMs: number | null;
  /** Retry attempt number of the pending retry (0 = none). */
  retryAttempt: number;
}

/** Input for creating a schedule. */
export interface FleetV25CreateScheduleInput {
  id: string;
  automationId: string;
  owner: string;
  name: string;
  kind: FleetV25ScheduleKind;
  cron?: string | null;
  intervalMs?: number | null;
  runAtMs?: number | null;
  timezone?: string;
  conditions?: FleetV25RunCondition[];
  retry?: Partial<FleetV25RetryPolicy> | null;
  enabled?: boolean;
}

/** Patch for updating a schedule (timing fields re-compute next run). */
export interface FleetV25UpdateScheduleInput {
  name?: string;
  kind?: FleetV25ScheduleKind;
  cron?: string | null;
  intervalMs?: number | null;
  runAtMs?: number | null;
  timezone?: string;
  conditions?: FleetV25RunCondition[];
  retry?: Partial<FleetV25RetryPolicy> | null;
}

/** Validate schedule timing input. Returns problems (empty = valid). */
export function validateFleetV25ScheduleTiming(input: {
  kind: FleetV25ScheduleKind;
  cron?: string | null;
  intervalMs?: number | null;
  runAtMs?: number | null;
}): string[] {
  const problems: string[] = [];
  if (input.kind === 'cron') {
    if (!input.cron?.trim()) problems.push('Cron schedules need a cron expression.');
    else problems.push(...validateFleetV25Cron(input.cron).problems);
    if (input.intervalMs !== null && input.intervalMs !== undefined) {
      problems.push('Cron schedules must not set intervalMs.');
    }
    if (input.runAtMs !== null && input.runAtMs !== undefined) {
      problems.push('Cron schedules must not set runAtMs.');
    }
  } else if (input.kind === 'interval') {
    if (input.intervalMs === null || input.intervalMs === undefined) {
      problems.push('Interval schedules need intervalMs.');
    } else if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1000) {
      problems.push('intervalMs must be an integer >= 1000 (1s minimum).');
    } else if (input.intervalMs > 366 * 24 * 60 * 60 * 1000) {
      problems.push('intervalMs must be at most 1 year.');
    }
    if (input.cron?.trim()) problems.push('Interval schedules must not set cron.');
    if (input.runAtMs !== null && input.runAtMs !== undefined) {
      problems.push('Interval schedules must not set runAtMs.');
    }
  } else if (input.kind === 'once') {
    if (input.runAtMs === null || input.runAtMs === undefined) {
      problems.push('One-shot schedules need runAtMs.');
    } else if (!Number.isInteger(input.runAtMs) || input.runAtMs < 0) {
      problems.push('runAtMs must be an epoch ms >= 0.');
    }
    if (input.cron?.trim()) problems.push('One-shot schedules must not set cron.');
    if (input.intervalMs !== null && input.intervalMs !== undefined) {
      problems.push('One-shot schedules must not set intervalMs.');
    }
  } else {
    problems.push(`Unknown schedule kind: ${String(input.kind)}.`);
  }
  return problems;
}

/** Compute the next fire time for a schedule after `fromMs`. */
export function computeFleetV25NextRun(
  schedule: Pick<FleetV25Schedule, 'kind' | 'cron' | 'intervalMs' | 'runAtMs' | 'lastRunAtMs' | 'lastFinishedAtMs'>,
  fromMs: number,
): number | null {
  if (schedule.kind === 'once') {
    if (schedule.runAtMs === null) return null;
    return schedule.runAtMs > fromMs ? schedule.runAtMs : null;
  }
  if (schedule.kind === 'interval') {
    if (schedule.intervalMs === null) return null;
    const anchor = schedule.lastRunAtMs ?? fromMs;
    // Next slot strictly after fromMs, anchored on the last run (or now).
    if (anchor >= fromMs) return anchor + schedule.intervalMs;
    const elapsed = fromMs - anchor;
    const steps = Math.floor(elapsed / schedule.intervalMs) + 1;
    return anchor + steps * schedule.intervalMs;
  }
  // cron
  if (!schedule.cron) return null;
  const parsed = parseFleetV25Cron(schedule.cron);
  return nextFleetV25CronRunMs(parsed, fromMs);
}

function cleanScheduleId(id: unknown): string {
  if (typeof id !== 'string') throw new Error('Schedule id must be a string.');
  const v = id.trim();
  if (!v) throw new Error('Schedule id must not be empty.');
  if (v.length > 128) throw new Error('Schedule id must be at most 128 characters.');
  return v;
}

function cleanNonEmpty(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const v = value.trim();
  if (!v) throw new Error(`${label} must not be empty.`);
  if (v.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return v;
}

function mergeRetry(input: Partial<FleetV25RetryPolicy> | null | undefined): FleetV25RetryPolicy {
  // Drop explicit `undefined` fields first: a partial patch must never
  // overwrite a default with undefined (e.g. tools passing through
  // an absent maxRetries).
  const clean: Partial<FleetV25RetryPolicy> = {};
  if (input) {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) (clean as Record<string, unknown>)[key] = value;
    }
  }
  const merged: FleetV25RetryPolicy = {
    ...FLEET_V25_DEFAULT_RETRY_POLICY,
    ...clean,
    retryOn: clean.retryOn ? [...clean.retryOn] : [...FLEET_V25_DEFAULT_RETRY_POLICY.retryOn],
  };
  const problems = validateFleetV25RetryPolicy(merged);
  if (problems.length > 0) throw new Error(`Invalid retry policy: ${problems.join(' ')}`);
  return merged;
}

function validateConditions(conditions: FleetV25RunCondition[]): void {
  const problems: string[] = [];
  conditions.forEach((c, i) => {
    for (const p of validateFleetV25Condition(c)) problems.push(`condition[${i}]: ${p}`);
  });
  if (problems.length > 0) throw new Error(`Invalid run conditions: ${problems.join(' ')}`);
}

/** The schedule registry (in-memory store + validation). */
export class FleetV25ScheduleRegistry {
  private readonly schedules = new Map<string, FleetV25Schedule>();

  /** Number of schedules in the registry. */
  get size(): number {
    return this.schedules.size;
  }

  /** Create a schedule. Throws on duplicate id / bad input. */
  create(input: FleetV25CreateScheduleInput, nowMs: number): FleetV25Schedule {
    const id = cleanScheduleId(input.id);
    if (this.schedules.has(id)) throw new Error(`Schedule "${id}" already exists.`);
    const timingProblems = validateFleetV25ScheduleTiming({
      kind: input.kind,
      cron: input.cron ?? null,
      intervalMs: input.intervalMs ?? null,
      runAtMs: input.runAtMs ?? null,
    });
    if (timingProblems.length > 0) {
      throw new Error(`Invalid schedule timing: ${timingProblems.join(' ')}`);
    }
    const conditions = (input.conditions ?? []).map((c) => ({ ...c, outcomes: c.outcomes ? [...c.outcomes] : undefined }));
    validateConditions(conditions);
    const schedule: FleetV25Schedule = {
      id,
      automationId: cleanNonEmpty(input.automationId, 'automationId'),
      owner: cleanNonEmpty(input.owner, 'owner'),
      name: cleanNonEmpty(input.name, 'Schedule name'),
      kind: input.kind,
      cron: input.kind === 'cron' ? parseFleetV25Cron(input.cron!).text : null,
      intervalMs: input.kind === 'interval' ? input.intervalMs! : null,
      runAtMs: input.kind === 'once' ? input.runAtMs! : null,
      timezone: input.timezone?.trim() ? input.timezone.trim() : 'UTC',
      conditions,
      retry: mergeRetry(input.retry),
      enabled: input.enabled ?? true,
      paused: false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastFinishedAtMs: null,
      lastOutcome: null,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      consecutiveFailures: 0,
      retryAtMs: null,
      retryAttempt: 0,
    };
    schedule.nextRunAtMs = schedule.enabled
      ? computeFleetV25NextRun(schedule, nowMs)
      : null;
    this.schedules.set(id, schedule);
    return this.copy(schedule);
  }

  /** Get a schedule by id (undefined when absent). Returns a copy. */
  get(id: string): FleetV25Schedule | undefined {
    const s = this.schedules.get(id.trim());
    return s ? this.copy(s) : undefined;
  }

  /** true when a schedule with this id exists. */
  has(id: string): boolean {
    return this.schedules.has(id.trim());
  }

  /** All schedules, sorted by id. */
  list(): FleetV25Schedule[] {
    return [...this.schedules.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => this.copy(s));
  }

  /** Schedules for one automation. */
  byAutomation(automationId: string): FleetV25Schedule[] {
    return this.list().filter((s) => s.automationId === automationId.trim());
  }

  /** Schedules owned by one owner. */
  byOwner(owner: string): FleetV25Schedule[] {
    return this.list().filter((s) => s.owner === owner.trim());
  }

  /** Schedules of one kind. */
  byKind(kind: FleetV25ScheduleKind): FleetV25Schedule[] {
    return this.list().filter((s) => s.kind === kind);
  }

  /** Live schedules (enabled and not paused). */
  live(): FleetV25Schedule[] {
    return this.list().filter((s) => s.enabled && !s.paused);
  }

  /**
   * Schedules due at `nowMs`: live, and either their next run time or
   * a pending retry has arrived. Sorted by fire time (earliest first).
   */
  dueSchedules(nowMs: number): FleetV25Schedule[] {
    return this.live()
      .filter((s) => {
        if (s.retryAtMs !== null && s.retryAtMs <= nowMs) return true;
        return s.nextRunAtMs !== null && s.nextRunAtMs <= nowMs;
      })
      .sort((a, b) => {
        const fa = Math.min(a.retryAtMs ?? Infinity, a.nextRunAtMs ?? Infinity);
        const fb = Math.min(b.retryAtMs ?? Infinity, b.nextRunAtMs ?? Infinity);
        return fa - fb || a.id.localeCompare(b.id);
      });
  }

  /** Update timing/name/conditions/retry of a schedule. Re-computes next run. */
  update(id: string, patch: FleetV25UpdateScheduleInput, nowMs: number): FleetV25Schedule {
    const s = this.require(id);
    const next: Pick<FleetV25Schedule, 'kind' | 'cron' | 'intervalMs' | 'runAtMs'> = {
      kind: patch.kind ?? s.kind,
      cron: patch.kind !== undefined ? (patch.cron ?? null) : (patch.cron !== undefined ? patch.cron : s.cron),
      intervalMs: patch.kind !== undefined ? (patch.intervalMs ?? null) : (patch.intervalMs !== undefined ? patch.intervalMs : s.intervalMs),
      runAtMs: patch.kind !== undefined ? (patch.runAtMs ?? null) : (patch.runAtMs !== undefined ? patch.runAtMs : s.runAtMs),
    };
    const timingProblems = validateFleetV25ScheduleTiming(next);
    if (timingProblems.length > 0) {
      throw new Error(`Invalid schedule timing: ${timingProblems.join(' ')}`);
    }
    if (patch.name !== undefined) s.name = cleanNonEmpty(patch.name, 'Schedule name');
    if (patch.timezone !== undefined) s.timezone = patch.timezone.trim() || 'UTC';
    if (patch.conditions !== undefined) {
      const conditions = patch.conditions.map((c) => ({ ...c, outcomes: c.outcomes ? [...c.outcomes] : undefined }));
      validateConditions(conditions);
      s.conditions = conditions;
    }
    if (patch.retry !== undefined) s.retry = mergeRetry({ ...s.retry, ...patch.retry });
    s.kind = next.kind;
    s.cron = next.kind === 'cron' ? parseFleetV25Cron(next.cron!).text : null;
    s.intervalMs = next.kind === 'interval' ? next.intervalMs! : null;
    s.runAtMs = next.kind === 'once' ? next.runAtMs! : null;
    // A timing change clears any pending retry (the old fire is stale).
    s.retryAtMs = null;
    s.retryAttempt = 0;
    s.updatedAtMs = nowMs;
    s.nextRunAtMs = s.enabled && !s.paused ? computeFleetV25NextRun(s, nowMs) : null;
    return this.copy(s);
  }

  /** Enable a schedule (re-computes its next run). */
  enable(id: string, nowMs: number): FleetV25Schedule {
    const s = this.require(id);
    s.enabled = true;
    s.updatedAtMs = nowMs;
    s.nextRunAtMs = !s.paused ? computeFleetV25NextRun(s, nowMs) : null;
    return this.copy(s);
  }

  /** Disable a schedule (never fires; next run cleared). */
  disable(id: string, nowMs: number): FleetV25Schedule {
    const s = this.require(id);
    s.enabled = false;
    s.retryAtMs = null;
    s.retryAttempt = 0;
    s.nextRunAtMs = null;
    s.updatedAtMs = nowMs;
    return this.copy(s);
  }

  /** Pause a schedule (never fires while paused; next run kept for resume). */
  pause(id: string, nowMs: number): FleetV25Schedule {
    const s = this.require(id);
    s.paused = true;
    s.updatedAtMs = nowMs;
    return this.copy(s);
  }

  /** Resume a paused schedule (re-computes its next run from now). */
  resume(id: string, nowMs: number): FleetV25Schedule {
    const s = this.require(id);
    s.paused = false;
    s.updatedAtMs = nowMs;
    s.nextRunAtMs = s.enabled ? computeFleetV25NextRun(s, nowMs) : null;
    return this.copy(s);
  }

  /** Remove a schedule permanently. */
  remove(id: string): boolean {
    return this.schedules.delete(cleanScheduleId(id));
  }

  /**
   * Record that a run started: bumps counters, clears the pending
   * retry when the run IS the retry, and advances the next run time.
   * Called by the engine when it dispatches.
   */
  recordRunStart(id: string, nowMs: number, isRetry: boolean): FleetV25Schedule {
    const s = this.require(id);
    s.lastRunAtMs = nowMs;
    s.runCount += 1;
    if (isRetry) {
      s.retryAtMs = null;
      s.retryAttempt = 0;
    }
    s.nextRunAtMs = computeFleetV25NextRun(s, nowMs);
    s.updatedAtMs = nowMs;
    return this.copy(s);
  }

  /**
   * Record a run outcome: updates counters, consecutive failures,
   * last outcome, and arms the next retry when the policy says so.
   * Returns the updated schedule.
   */
  recordRunOutcome(
    id: string,
    outcome: FleetV25ScheduledOutcome,
    nowMs: number,
    attempt: number,
  ): FleetV25Schedule {
    const s = this.require(id);
    s.lastFinishedAtMs = nowMs;
    s.lastOutcome = outcome;
    if (outcome === 'completed') {
      s.successCount += 1;
      s.consecutiveFailures = 0;
    } else if (outcome === 'failed') {
      s.failureCount += 1;
      s.consecutiveFailures += 1;
      if (fleetV25ShouldRetry(s.retry, outcome, attempt)) {
        s.retryAtMs = nowMs + fleetV25RetryDelayMs(s.retry, attempt);
        s.retryAttempt = attempt;
      }
    } else if (outcome === 'skipped-condition') {
      s.skippedCount += 1;
      // A skipped run is not a failure, and it consumes any pending
      // retry: the retry window passed and the condition failed at
      // fire time, so the retry must not stay due forever.
      s.retryAtMs = null;
      s.retryAttempt = 0;
      // Next run advances normally.
      s.nextRunAtMs = computeFleetV25NextRun(s, nowMs);
    }
    // One-shot schedules never fire again once they ran.
    if (s.kind === 'once' && outcome !== 'skipped-condition') {
      s.nextRunAtMs = null;
    }
    s.updatedAtMs = nowMs;
    return this.copy(s);
  }

  /** Recompute every schedule's next run (after a clock jump). */
  recomputeAll(nowMs: number): void {
    for (const s of this.schedules.values()) {
      if (s.enabled && !s.paused) {
        s.nextRunAtMs = computeFleetV25NextRun(s, nowMs);
      }
    }
  }

  /** Per-kind counts + live/paused/disabled breakdown. */
  stats(): {
    total: number;
    live: number;
    paused: number;
    disabled: number;
    byKind: Record<FleetV25ScheduleKind, number>;
    runs: number;
    successes: number;
    failures: number;
    skipped: number;
  } {
    const all = this.list();
    const byKind: Record<FleetV25ScheduleKind, number> = { cron: 0, interval: 0, once: 0 };
    for (const s of all) byKind[s.kind] += 1;
    return {
      total: all.length,
      live: all.filter((s) => s.enabled && !s.paused).length,
      paused: all.filter((s) => s.paused).length,
      disabled: all.filter((s) => !s.enabled).length,
      byKind,
      runs: all.reduce((n, s) => n + s.runCount, 0),
      successes: all.reduce((n, s) => n + s.successCount, 0),
      failures: all.reduce((n, s) => n + s.failureCount, 0),
      skipped: all.reduce((n, s) => n + s.skippedCount, 0),
    };
  }

  private require(id: string): FleetV25Schedule {
    const s = this.schedules.get(cleanScheduleId(id));
    if (!s) throw new Error(`Schedule "${id.trim()}" does not exist.`);
    return s;
  }

  private copy(s: FleetV25Schedule): FleetV25Schedule {
    return {
      ...s,
      conditions: s.conditions.map((c) => ({ ...c, outcomes: c.outcomes ? [...c.outcomes] : undefined })),
      retry: { ...s.retry, retryOn: [...s.retry.retryOn] },
    };
  }
}

/** Create an empty schedule registry. */
export function createFleetV25ScheduleRegistry(): FleetV25ScheduleRegistry {
  return new FleetV25ScheduleRegistry();
}

/** One-line summary of the registry (for the dashboard header). */
export function summarizeFleetV25Schedules(registry: FleetV25ScheduleRegistry): string {
  const s = registry.stats();
  return (
    `${s.total} schedule${s.total === 1 ? '' : 's'} ` +
    `(${s.live} live, ${s.paused} paused, ${s.disabled} disabled; ` +
    `${s.byKind.cron} cron, ${s.byKind.interval} interval, ${s.byKind.once} one-shot; ` +
    `${s.runs} runs, ${s.successes} ok, ${s.failures} failed, ${s.skipped} skipped)`
  );
}
