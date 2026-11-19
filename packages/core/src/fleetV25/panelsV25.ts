/**
 * Panels v25 — view-models for the fleet v25 UI (v1.38, Đội T6).
 *
 * Follows the `fleetV24/panelsV24.ts` pattern: a pure module that
 * turns core state into JSON-able display data (rounded numbers,
 * one-line summaries) — it never renders and never reads i18n
 * directly (the UI uses the `fleet.v25.*` keys). The combined
 * dashboard joins the four v25 areas — roles/users, audit log,
 * schedules, scheduled runs — so the fleet page can show the whole
 * multi-user + automation picture in one place.
 */

import type { FleetV25AuditLog, FleetV25AuditSummary } from './auditLog';
import { summarizeFleetV25Audit } from './auditLog';
import type { FleetV25TickReport } from './automationEngine';
import { summarizeFleetV25Tick } from './automationEngine';
import {
  buildFleetV25PermissionMatrix,
  summarizeFleetV25Roles,
  type FleetV25PermissionMatrixRow,
} from './roles';
import type { FleetV25ScheduledRun } from './scheduledRuns';
import type { FleetV25Schedule, FleetV25ScheduleRegistry } from './schedules';
import { summarizeFleetV25Schedules } from './schedules';
import type { FleetV25User, FleetV25UserStore } from './users';
import { summarizeFleetV25Users } from './users';

/** One row of the roles matrix (for the roles panel). */
export type FleetV25RolesPanelRow = FleetV25PermissionMatrixRow;

/** View-model: roles + permission matrix. */
export interface FleetV25RolesPanel {
  /** One-line summary (English; UI uses i18n keys). */
  summary: string;
  /** Roles, lowest privilege first. */
  roles: string[];
  /** Role × action matrix. */
  matrix: FleetV25PermissionMatrixRow[];
  /** Action counts per role. */
  counts: ReturnType<typeof summarizeFleetV25Roles>;
}

/** Build the roles panel (no store needed — the matrix is static). */
export function buildFleetV25RolesPanel(): FleetV25RolesPanel {
  const counts = summarizeFleetV25Roles();
  return {
    summary:
      `${counts.roles} roles, ${counts.actions} actions ` +
      `(${counts.readActions} read, ${counts.writeActions} write; ` +
      `viewer holds ${counts.viewerActions}, operator holds ${counts.operatorActions}, ` +
      `${counts.adminOnlyActions} admin-only)`,
    roles: ['viewer', 'operator', 'admin'],
    matrix: buildFleetV25PermissionMatrix(),
    counts,
  };
}

/** View-model: one user row (already safe for display — no secrets). */
export interface FleetV25UserRow {
  id: string;
  name: string;
  email: string | null;
  role: FleetV25User['role'];
  status: FleetV25User['status'];
  scopeTags: string[];
  scopeOwners: string[];
  scopeAutomationIds: string[];
  /** true when the scope restricts the user at all. */
  scoped: boolean;
  createdAtMs: number;
  lastActiveAtMs: number | null;
  note: string | null;
}

/** Build one user row from a core record. */
export function buildFleetV25UserRow(u: FleetV25User): FleetV25UserRow {
  const scoped = Boolean(
    (u.scope.tags && u.scope.tags.length > 0) ||
    (u.scope.owners && u.scope.owners.length > 0) ||
    (u.scope.automationIds && u.scope.automationIds.length > 0),
  );
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    scopeTags: [...(u.scope.tags ?? [])],
    scopeOwners: [...(u.scope.owners ?? [])],
    scopeAutomationIds: [...(u.scope.automationIds ?? [])],
    scoped,
    createdAtMs: u.createdAtMs,
    lastActiveAtMs: u.lastActiveAtMs,
    note: u.note,
  };
}

/** View-model: the user directory. */
export interface FleetV25UsersPanel {
  /** One-line summary. */
  summary: string;
  /** Counts by role/status. */
  counts: ReturnType<FleetV25UserStore['counts']>;
  /** User rows, sorted by id. */
  users: FleetV25UserRow[];
  /** Active admins (the users keeping the fleet administrable). */
  activeAdmins: FleetV25UserRow[];
  /** Scoped users (restricted to tags/owners/automations). */
  scopedUsers: FleetV25UserRow[];
}

/** Build the users panel from the directory. */
export function buildFleetV25UsersPanel(store: FleetV25UserStore): FleetV25UsersPanel {
  const users = store.list().map(buildFleetV25UserRow);
  return {
    summary: summarizeFleetV25Users(store),
    counts: store.counts(),
    users,
    activeAdmins: users.filter((u) => u.role === 'admin' && u.status === 'active'),
    scopedUsers: users.filter((u) => u.scoped),
  };
}

/** View-model: the audit log. */
export interface FleetV25AuditPanel {
  /** One-line summary (incl. chain validity). */
  summary: string;
  /** Summary counts. */
  stats: FleetV25AuditSummary;
  /** Chain valid? */
  chainValid: boolean;
  /** First bad seq when the chain is broken (null when valid). */
  badSeq: number | null;
  /** Newest entries first (latest 20). */
  recent: ReturnType<FleetV25AuditLog['query']>;
  /** Denied attempts (latest 20, newest first). */
  denied: ReturnType<FleetV25AuditLog['query']>;
  /** Failed actions (latest 20, newest first). */
  failures: ReturnType<FleetV25AuditLog['query']>;
}

/** Build the audit panel from the log. */
export function buildFleetV25AuditPanel(log: FleetV25AuditLog): FleetV25AuditPanel {
  const verify = log.verify();
  return {
    summary: summarizeFleetV25Audit(log),
    stats: log.summary(),
    chainValid: verify.ok,
    badSeq: verify.badSeq,
    recent: log.query({ newestFirst: true, limit: 20 }),
    denied: log.denied(20),
    failures: log.failures(20),
  };
}

/** View-model: one schedule row (already rounded for display). */
export interface FleetV25ScheduleRow {
  id: string;
  name: string;
  automationId: string;
  owner: string;
  kind: FleetV25Schedule['kind'];
  cron: string | null;
  intervalMs: number | null;
  runAtMs: number | null;
  timezone: string;
  conditionCount: number;
  maxRetries: number;
  enabled: boolean;
  paused: boolean;
  /** Live = enabled and not paused. */
  live: boolean;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastOutcome: FleetV25Schedule['lastOutcome'];
  runCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  /** Success rate over finished runs, 0-100, rounded. */
  successRatePct: number;
  consecutiveFailures: number;
  retryAtMs: number | null;
  retryAttempt: number;
}

/** Build one schedule row from a core record. */
export function buildFleetV25ScheduleRow(s: FleetV25Schedule): FleetV25ScheduleRow {
  const finished = s.successCount + s.failureCount;
  return {
    id: s.id,
    name: s.name,
    automationId: s.automationId,
    owner: s.owner,
    kind: s.kind,
    cron: s.cron,
    intervalMs: s.intervalMs,
    runAtMs: s.runAtMs,
    timezone: s.timezone,
    conditionCount: s.conditions.length,
    maxRetries: s.retry.maxRetries,
    enabled: s.enabled,
    paused: s.paused,
    live: s.enabled && !s.paused,
    nextRunAtMs: s.nextRunAtMs,
    lastRunAtMs: s.lastRunAtMs,
    lastOutcome: s.lastOutcome,
    runCount: s.runCount,
    successCount: s.successCount,
    failureCount: s.failureCount,
    skippedCount: s.skippedCount,
    successRatePct: finished > 0 ? Math.round((s.successCount / finished) * 100) : 0,
    consecutiveFailures: s.consecutiveFailures,
    retryAtMs: s.retryAtMs,
    retryAttempt: s.retryAttempt,
  };
}

/** View-model: the schedules panel. */
export interface FleetV25SchedulesPanel {
  /** One-line summary. */
  summary: string;
  /** Registry stats. */
  stats: ReturnType<FleetV25ScheduleRegistry['stats']>;
  /** Schedule rows, sorted by next run (soonest first, nulls last). */
  schedules: FleetV25ScheduleRow[];
  /** Schedules due within the next hour (from `nowMs`). */
  dueSoon: FleetV25ScheduleRow[];
  /** Schedules with a pending retry. */
  pendingRetries: FleetV25ScheduleRow[];
  /** Schedules with 3+ consecutive failures (need attention). */
  failing: FleetV25ScheduleRow[];
}

/** Build the schedules panel from the registry. */
export function buildFleetV25SchedulesPanel(
  registry: FleetV25ScheduleRegistry,
  nowMs: number,
): FleetV25SchedulesPanel {
  const rows = registry.list().map(buildFleetV25ScheduleRow);
  const byNextRun = [...rows].sort((a, b) => {
    if (a.nextRunAtMs === null && b.nextRunAtMs === null) return a.id.localeCompare(b.id);
    if (a.nextRunAtMs === null) return 1;
    if (b.nextRunAtMs === null) return -1;
    return a.nextRunAtMs - b.nextRunAtMs;
  });
  return {
    summary: summarizeFleetV25Schedules(registry),
    stats: registry.stats(),
    schedules: byNextRun,
    dueSoon: byNextRun.filter(
      (r) => r.live && r.nextRunAtMs !== null && r.nextRunAtMs <= nowMs + 3600000,
    ),
    pendingRetries: rows.filter((r) => r.retryAtMs !== null),
    failing: rows.filter((r) => r.consecutiveFailures >= 3),
  };
}

/** View-model: one scheduled-run row. */
export interface FleetV25ScheduledRunRow {
  id: string;
  groupId: string;
  attempt: number;
  scheduleId: string;
  automationId: string;
  owner: string;
  trigger: FleetV25ScheduledRun['trigger'];
  startedAtMs: number;
  finishedAtMs: number | null;
  outcome: FleetV25ScheduledRun['outcome'];
  durationMs: number | null;
  error: string | null;
  skippedByCondition: boolean;
  conditionsPassed: number;
  conditionsFailed: number;
}

/** Build one run row from a core record. */
export function buildFleetV25ScheduledRunRow(r: FleetV25ScheduledRun): FleetV25ScheduledRunRow {
  return {
    id: r.id,
    groupId: r.groupId,
    attempt: r.attempt,
    scheduleId: r.scheduleId,
    automationId: r.automationId,
    owner: r.owner,
    trigger: r.trigger,
    startedAtMs: r.startedAtMs,
    finishedAtMs: r.finishedAtMs,
    outcome: r.outcome,
    durationMs: r.durationMs,
    error: r.error,
    skippedByCondition: r.skippedByCondition,
    conditionsPassed: r.conditionResults.filter((c) => c.passed).length,
    conditionsFailed: r.conditionResults.filter((c) => !c.passed).length,
  };
}

/** View-model: the scheduled-runs panel. */
export interface FleetV25ScheduledRunsPanel {
  /** One-line summary. */
  summary: string;
  /** Counts by outcome. */
  countsByOutcome: Record<FleetV25ScheduledRun['outcome'], number>;
  /** Failure rate over finished runs, 0-100, rounded. */
  failureRatePct: number;
  /** Timing over finished runs. */
  timing: ReturnType<import('./scheduledRuns').FleetV25ScheduledRunLedger['timing']>;
  /** Recent runs (latest 20, newest first). */
  recent: FleetV25ScheduledRunRow[];
  /** Stuck runs (still in flight past `stuckAfterMs`). */
  stuck: FleetV25ScheduledRunRow[];
  /** Retry groups (latest 10, newest first). */
  groups: ReturnType<import('./scheduledRuns').FleetV25ScheduledRunLedger['groupSummaries']>;
}

/** Build the scheduled-runs panel from the ledger. */
export function buildFleetV25ScheduledRunsPanel(
  ledger: import('./scheduledRuns').FleetV25ScheduledRunLedger,
  nowMs: number,
  stuckAfterMs = 30 * 60 * 1000,
): FleetV25ScheduledRunsPanel {
  const counts = ledger.countsByOutcome();
  const finished = counts.completed + counts.failed + counts.cancelled;
  const total = ledger.size;
  return {
    summary:
      `${total} scheduled run${total === 1 ? '' : 's'} ` +
      `(${counts.completed} completed, ${counts.failed} failed, ` +
      `${counts['skipped-condition']} skipped, ${counts.running} running, ` +
      `${counts.cancelled} cancelled)`,
    countsByOutcome: counts,
    failureRatePct: finished > 0 ? Math.round((counts.failed / finished) * 100) : 0,
    timing: ledger.timing(),
    recent: ledger.query({ newestFirst: true, limit: 20 }).map(buildFleetV25ScheduledRunRow),
    stuck: ledger.stuckRuns(nowMs, stuckAfterMs).map(buildFleetV25ScheduledRunRow),
    groups: ledger.groupSummaries().slice(0, 10),
  };
}

/** View-model: the last tick (for the dashboard). */
export interface FleetV25LastTickPanel {
  summary: string;
  report: FleetV25TickReport | null;
}

/** The combined fleet v25 dashboard. */
export interface FleetV25Dashboard {
  /** One-line summary across all four areas. */
  summary: string;
  roles: FleetV25RolesPanel;
  users: FleetV25UsersPanel;
  audit: FleetV25AuditPanel;
  schedules: FleetV25SchedulesPanel;
  runs: FleetV25ScheduledRunsPanel;
  lastTick: FleetV25LastTickPanel;
}

/** Build the combined fleet v25 dashboard. */
export function buildFleetV25Dashboard(
  users: FleetV25UserStore,
  audit: FleetV25AuditLog,
  registry: FleetV25ScheduleRegistry,
  ledger: import('./scheduledRuns').FleetV25ScheduledRunLedger,
  nowMs: number,
  lastTick: FleetV25TickReport | null = null,
): FleetV25Dashboard {
  const roles = buildFleetV25RolesPanel();
  const usersPanel = buildFleetV25UsersPanel(users);
  const auditPanel = buildFleetV25AuditPanel(audit);
  const schedules = buildFleetV25SchedulesPanel(registry, nowMs);
  const runs = buildFleetV25ScheduledRunsPanel(ledger, nowMs);
  return {
    summary:
      `${usersPanel.summary}; ${auditPanel.summary}; ` +
      `${schedules.summary}; ${runs.summary}` +
      (lastTick ? `; last tick: ${summarizeFleetV25Tick(lastTick)}` : ''),
    roles,
    users: usersPanel,
    audit: auditPanel,
    schedules,
    runs,
    lastTick: {
      summary: lastTick ? summarizeFleetV25Tick(lastTick) : 'No tick has run yet.',
      report: lastTick,
    },
  };
}
