/**
 * Stop hook feedback v24 (v1.37, Đội T6).
 *
 * When a stop hook fires — a user presses Stop, a watchdog process kills
 * a runaway run, a rule trips, a timeout expires, or an approval is
 * denied — the run stops, but the *reason* used to vanish with it. This
 * module records that feedback so an operator can answer, afterwards:
 * "why did this run stop, who or what stopped it, and what should happen
 * next?"
 *
 * Concepts:
 * - `FleetV24StopTrigger` — who/what fired the hook: a human (`user`),
 *   another process (`process`), an automated rule (`rule`), a timeout
 *   (`timeout`), an approval denial (`approval`), or the system itself
 *   (`system`). The trigger kind is separate from the trigger name so
 *   the dashboard can group by kind ("all rule stops this week") while
 *   still showing the exact actor ("rule `nightly-guard`").
 * - `FleetV24StopAction` — what the hook decided: `stop` (hard stop),
 *   `pause` (stop now, resumable), `retry` (stop this attempt, schedule
 *   a retry), `escalate` (stop and hand to a human), `ignore` (hook
 *   fired but the stop was overruled — recorded, run kept going).
 * - `FleetV24StopHookFeedback` — one feedback record: run + automation
 *   ids, the stop reason in plain language, trigger kind + actor name,
 *   the action taken, a suggested next action derived from the reason
 *   when the caller does not supply one, and acknowledgement state
 *   (unacknowledged feedback is the operator's to-do list).
 * - `FleetV24StopHookFeedbackStore` — append-only store with a cap.
 *   Queries: by run, by automation, by trigger kind, by action,
 *   unacknowledged only, recent, and per-automation/per-trigger
 *   summaries for the dashboard.
 *
 * The suggested next action is derived by rule, not by a model:
 * timeouts suggest raising the limit or splitting the work, approval
 * denials suggest fixing the request, rule stops suggest reviewing the
 * rule, and so on. The caller can always override the suggestion.
 */

/** Who/what fired the stop hook. */
export type FleetV24StopTrigger =
  | 'user'
  | 'process'
  | 'rule'
  | 'timeout'
  | 'approval'
  | 'system';

/** What the stop hook decided to do. */
export type FleetV24StopAction = 'stop' | 'pause' | 'retry' | 'escalate' | 'ignore';

/** All trigger kinds, in dashboard display order. */
export const FLEET_V24_STOP_TRIGGERS: readonly FleetV24StopTrigger[] = [
  'user',
  'process',
  'rule',
  'timeout',
  'approval',
  'system',
];

/** All stop actions, in dashboard display order. */
export const FLEET_V24_STOP_ACTIONS: readonly FleetV24StopAction[] = [
  'stop',
  'pause',
  'retry',
  'escalate',
  'ignore',
];

/** One stop-hook feedback record. */
export interface FleetV24StopHookFeedback {
  /** Feedback id, unique inside the store. */
  id: string;
  /** Run that was stopped (or that the hook considered stopping). */
  runId: string;
  /** Automation the run belongs to. */
  automationId: string;
  /** Plain-language reason the hook fired (e.g. `max-steps reached`). */
  reason: string;
  /** Who/what fired the hook. */
  triggeredBy: FleetV24StopTrigger;
  /** Name of the actor: user id, process name, rule id, ... */
  triggeredByName: string;
  /** What the hook decided. */
  action: FleetV24StopAction;
  /** Suggested next action for the operator. */
  suggestedNextAction: string;
  /** When the hook fired (epoch ms). */
  stoppedAtMs: number;
  /** True once an operator has reviewed this feedback. */
  acknowledged: boolean;
  /** Who acknowledged it (null = not acknowledged yet). */
  acknowledgedBy: string | null;
  /** When it was acknowledged (epoch ms, null = not yet). */
  acknowledgedAtMs: number | null;
  /** Optional operator note added at acknowledgement time. */
  acknowledgeNote: string | null;
}

/** Input for recording stop-hook feedback. */
export interface FleetV24RecordStopHookInput {
  id: string;
  runId: string;
  automationId: string;
  reason: string;
  triggeredBy: FleetV24StopTrigger;
  triggeredByName: string;
  action: FleetV24StopAction;
  /** Override the derived suggestion; null/empty = derive from reason. */
  suggestedNextAction?: string | null;
}

/** Filter for querying feedback. Every field is optional (AND-combined). */
export interface FleetV24StopHookQuery {
  runId?: string;
  automationId?: string;
  triggeredBy?: FleetV24StopTrigger;
  action?: FleetV24StopAction;
  acknowledged?: boolean;
  /** Only feedback fired at or after this instant. */
  fromMs?: number;
  /** Only feedback fired before this instant. */
  toMs?: number;
  /** Only feedback whose reason contains this text (case-insensitive). */
  reasonContains?: string;
}

/** Summary counts for one automation's stop feedback. */
export interface FleetV24StopHookSummary {
  /** Automation id (or `*` for fleet-wide). */
  key: string;
  /** Total feedback records. */
  total: number;
  /** Not yet acknowledged. */
  unacknowledged: number;
  /** Breakdown by trigger kind. */
  byTrigger: Record<FleetV24StopTrigger, number>;
  /** Breakdown by action taken. */
  byAction: Record<FleetV24StopAction, number>;
  /** Most recent feedback timestamp (null when none). */
  latestAtMs: number | null;
}

/** Maximum feedback records kept per store (oldest dropped first). */
export const FLEET_V24_STOP_HOOK_CAP = 2000;

/** Maximum feedback id length. */
export const FLEET_V24_STOP_HOOK_ID_MAX = 128;

/**
 * Derive a suggested next action from the stop reason + trigger.
 *
 * Rule-based, in priority order: approval denials point at the request,
 * timeouts at the limit, max-steps at the scope, rule stops at the rule,
 * user stops at resuming manually, anything else at reviewing the run.
 * The caller may override the suggestion when recording.
 */
export function suggestFleetV24NextAction(
  reason: string,
  triggeredBy: FleetV24StopTrigger,
  action: FleetV24StopAction,
): string {
  const lower = reason.toLowerCase();
  if (action === 'ignore') {
    return 'No action needed — the stop was overruled and the run continued.';
  }
  if (triggeredBy === 'approval' || lower.includes('approval') || lower.includes('denied')) {
    return 'Review the denied request, fix what the approver objected to, then re-run.';
  }
  if (triggeredBy === 'timeout' || lower.includes('timeout') || lower.includes('timed out')) {
    return 'Raise the timeout for this automation or split the work into smaller runs.';
  }
  if (lower.includes('max-steps') || lower.includes('step limit') || lower.includes('too many steps')) {
    return 'Reduce the scope of the task or raise the step limit, then resume from the last checkpoint.';
  }
  if (lower.includes('loop') || lower.includes('repeat')) {
    return 'Inspect the run log for the repeating step, fix the loop, then re-run.';
  }
  if (triggeredBy === 'rule') {
    return 'Review the rule that fired; if the stop was wrong, tune the rule before re-running.';
  }
  if (triggeredBy === 'process') {
    return 'Check the stopping process logs, confirm the run is safe to resume, then resume it.';
  }
  if (triggeredBy === 'user') {
    if (action === 'pause') return 'Resume the run manually when ready, or cancel it if it is no longer needed.';
    return 'Re-run the automation manually when ready; nothing else changed.';
  }
  if (lower.includes('error') || lower.includes('failed') || lower.includes('crash')) {
    return 'Read the run error, fix the underlying failure, then re-run.';
  }
  if (action === 'escalate') {
    return 'A human needs to decide: review the run and either resume, retry, or cancel it.';
  }
  if (action === 'retry') {
    return 'The retry is scheduled; check the next attempt and intervene only if it fails again.';
  }
  return 'Review the run log, decide whether the stop was correct, then resume or re-run.';
}

/** Validate a record-stop-hook input; returns the first problem, or null. */
export function validateFleetV24StopHookInput(input: FleetV24RecordStopHookInput): string | null {
  if (input.id.trim().length === 0) return 'Feedback id must not be empty.';
  if (input.id.trim().length > FLEET_V24_STOP_HOOK_ID_MAX) {
    return 'Feedback id must be at most 128 characters.';
  }
  if (/\s/.test(input.id.trim())) return 'Feedback id must not contain whitespace.';
  if (input.runId.trim().length === 0) return 'Run id must not be empty.';
  if (input.automationId.trim().length === 0) return 'Automation id must not be empty.';
  if (input.reason.trim().length === 0) return 'Stop reason must not be empty.';
  if (input.reason.trim().length > 1000) return 'Stop reason must be at most 1000 characters.';
  if (!FLEET_V24_STOP_TRIGGERS.includes(input.triggeredBy)) {
    return `Unknown stop trigger "${input.triggeredBy}".`;
  }
  if (input.triggeredByName.trim().length === 0) return 'Trigger name must not be empty.';
  if (!FLEET_V24_STOP_ACTIONS.includes(input.action)) {
    return `Unknown stop action "${input.action}".`;
  }
  if (
    input.suggestedNextAction !== undefined &&
    input.suggestedNextAction !== null &&
    input.suggestedNextAction.trim().length > 1000
  ) {
    return 'Suggested next action must be at most 1000 characters.';
  }
  return null;
}

/** Build a feedback record from a validated input. Throws on invalid input. */
export function createFleetV24StopHookFeedback(
  input: FleetV24RecordStopHookInput,
  nowMs: number,
): FleetV24StopHookFeedback {
  const error = validateFleetV24StopHookInput(input);
  if (error !== null) throw new Error(`Invalid stop-hook feedback: ${error}`);
  const suggestion =
    input.suggestedNextAction?.trim()
      ? input.suggestedNextAction.trim()
      : suggestFleetV24NextAction(input.reason, input.triggeredBy, input.action);
  return {
    id: input.id.trim(),
    runId: input.runId.trim(),
    automationId: input.automationId.trim(),
    reason: input.reason.trim(),
    triggeredBy: input.triggeredBy,
    triggeredByName: input.triggeredByName.trim(),
    action: input.action,
    suggestedNextAction: suggestion,
    stoppedAtMs: nowMs,
    acknowledged: false,
    acknowledgedBy: null,
    acknowledgedAtMs: null,
    acknowledgeNote: null,
  };
}

/** Empty summary for one key. */
function emptySummary(key: string): FleetV24StopHookSummary {
  return {
    key,
    total: 0,
    unacknowledged: 0,
    byTrigger: { user: 0, process: 0, rule: 0, timeout: 0, approval: 0, system: 0 },
    byAction: { stop: 0, pause: 0, retry: 0, escalate: 0, ignore: 0 },
    latestAtMs: null,
  };
}

/** Summarise a list of feedback records under one key. */
export function summarizeFleetV24StopHookFeedback(
  key: string,
  feedback: readonly FleetV24StopHookFeedback[],
): FleetV24StopHookSummary {
  const summary = emptySummary(key);
  for (const f of feedback) {
    summary.total += 1;
    if (!f.acknowledged) summary.unacknowledged += 1;
    summary.byTrigger[f.triggeredBy] += 1;
    summary.byAction[f.action] += 1;
    if (summary.latestAtMs === null || f.stoppedAtMs > summary.latestAtMs) {
      summary.latestAtMs = f.stoppedAtMs;
    }
  }
  return summary;
}

/**
 * Append-only store of stop-hook feedback.
 *
 * The host records feedback whenever a stop hook fires (from the agent
 * loop's `fireStopHook`, from a watchdog, from a rule engine, ...). The
 * dashboard reads it back by run or automation, and the operator's
 * to-do list is simply `unacknowledged()`.
 */
export class FleetV24StopHookFeedbackStore {
  private feedback: FleetV24StopHookFeedback[] = [];
  private readonly byId = new Map<string, FleetV24StopHookFeedback>();

  /** Number of feedback records stored. */
  get size(): number {
    return this.feedback.length;
  }

  /** All feedback, oldest first. */
  list(): FleetV24StopHookFeedback[] {
    return [...this.feedback];
  }

  /** Look one feedback record up by id. */
  get(id: string): FleetV24StopHookFeedback | undefined {
    return this.byId.get(id.trim());
  }

  /** Record feedback. Throws on invalid input or duplicate id. */
  record(input: FleetV24RecordStopHookInput, nowMs: number): FleetV24StopHookFeedback {
    const record = createFleetV24StopHookFeedback(input, nowMs);
    if (this.byId.has(record.id)) {
      throw new Error(`Stop-hook feedback "${record.id}" already exists.`);
    }
    this.feedback.push(record);
    this.byId.set(record.id, record);
    if (this.feedback.length > FLEET_V24_STOP_HOOK_CAP) {
      const dropped = this.feedback.splice(0, this.feedback.length - FLEET_V24_STOP_HOOK_CAP);
      for (const d of dropped) this.byId.delete(d.id);
    }
    return record;
  }

  /**
   * Acknowledge a feedback record. Returns false when the id is unknown.
   * Re-acknowledging overwrites the previous acknowledgement (the latest
   * review wins).
   */
  acknowledge(
    id: string,
    acknowledgedBy: string,
    nowMs: number,
    note?: string | null,
  ): FleetV24StopHookFeedback | null {
    const record = this.byId.get(id.trim());
    if (!record) return null;
    if (acknowledgedBy.trim().length === 0) {
      throw new Error('Acknowledged-by must not be empty.');
    }
    record.acknowledged = true;
    record.acknowledgedBy = acknowledgedBy.trim();
    record.acknowledgedAtMs = nowMs;
    record.acknowledgeNote = note?.trim() ? note.trim().slice(0, 1000) : null;
    return record;
  }

  /** Query feedback with an AND-combined filter, newest first. */
  query(query: FleetV24StopHookQuery, limit = 100): FleetV24StopHookFeedback[] {
    const runId = query.runId?.trim();
    const automationId = query.automationId?.trim();
    const reasonNeedle = query.reasonContains?.trim().toLowerCase();
    return this.feedback
      .filter((f) => {
        if (runId && f.runId !== runId) return false;
        if (automationId && f.automationId !== automationId) return false;
        if (query.triggeredBy && f.triggeredBy !== query.triggeredBy) return false;
        if (query.action && f.action !== query.action) return false;
        if (query.acknowledged !== undefined && f.acknowledged !== query.acknowledged) return false;
        if (query.fromMs !== undefined && f.stoppedAtMs < query.fromMs) return false;
        if (query.toMs !== undefined && f.stoppedAtMs >= query.toMs) return false;
        if (reasonNeedle && !f.reason.toLowerCase().includes(reasonNeedle)) return false;
        return true;
      })
      .sort((a, b) => b.stoppedAtMs - a.stoppedAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, limit));
  }

  /** Feedback for one run, newest first. */
  forRun(runId: string, limit = 50): FleetV24StopHookFeedback[] {
    return this.query({ runId }, limit);
  }

  /** Feedback for one automation, newest first. */
  forAutomation(automationId: string, limit = 50): FleetV24StopHookFeedback[] {
    return this.query({ automationId }, limit);
  }

  /** Feedback not yet acknowledged — the operator's to-do list. */
  unacknowledged(limit = 100): FleetV24StopHookFeedback[] {
    return this.query({ acknowledged: false }, limit);
  }

  /** Most recent feedback, newest first. */
  recent(limit = 20): FleetV24StopHookFeedback[] {
    return this.query({}, limit);
  }

  /** Fleet-wide summary. */
  summary(): FleetV24StopHookSummary {
    return summarizeFleetV24StopHookFeedback('*', this.feedback);
  }

  /** Summary for one automation. */
  summaryForAutomation(automationId: string): FleetV24StopHookSummary {
    const trimmed = automationId.trim();
    return summarizeFleetV24StopHookFeedback(
      trimmed,
      this.feedback.filter((f) => f.automationId === trimmed),
    );
  }

  /** Summaries for every automation that has feedback, most stops first. */
  summariesByAutomation(): FleetV24StopHookSummary[] {
    const byAutomation = new Map<string, FleetV24StopHookFeedback[]>();
    for (const f of this.feedback) {
      const bucket = byAutomation.get(f.automationId) ?? [];
      bucket.push(f);
      byAutomation.set(f.automationId, bucket);
    }
    return [...byAutomation.entries()]
      .map(([key, list]) => summarizeFleetV24StopHookFeedback(key, list))
      .sort((a, b) => b.total - a.total || b.unacknowledged - a.unacknowledged);
  }

  /** Summaries grouped by trigger kind (one summary per trigger). */
  summariesByTrigger(): FleetV24StopHookSummary[] {
    return FLEET_V24_STOP_TRIGGERS.map((trigger) =>
      summarizeFleetV24StopHookFeedback(
        trigger,
        this.feedback.filter((f) => f.triggeredBy === trigger),
      ),
    ).filter((s) => s.total > 0);
  }
}

/** Create an empty stop-hook feedback store. */
export function createFleetV24StopHookFeedbackStore(): FleetV24StopHookFeedbackStore {
  return new FleetV24StopHookFeedbackStore();
}
