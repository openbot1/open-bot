/**
 * Automation dashboard v24 — registry + grouping/filtering/stats (v1.37, Đội T6).
 *
 * Fleet v24 groups the automation fleet by tag and filters by owner, so an
 * operator can see "everything tagged `nightly` owned by `team-data`" at a
 * glance instead of scrolling one flat list. This module is the pure core:
 * no I/O, no timers, no rendering — the host owns persistence and the
 * renderer reads view-models from `panelsV24.ts`.
 *
 * Concepts:
 * - `FleetV24Automation` — one automation: id, human name, owner (a user
 *   id, team id or service account), a set of tags, a lifecycle status,
 *   and run counters that the run ledger (`automationRuns.ts`) keeps in
 *   sync. Tags and owners are normalised (trimmed, lower-cased for tags)
 *   at registration time so grouping never splits on whitespace/case.
 * - `FleetV24AutomationRegistry` — the in-memory registry. It owns the
 *   maps, validates every mutation, and records a small audit trail of
 *   lifecycle changes (register/enable/disable/pause/resume) so the
 *   dashboard can explain "who changed what, when".
 * - Group operations work on whole tag groups at once: enable, disable
 *   or pause every automation carrying a tag. A bulk operation is
 *   reported per automation (applied / skipped with a reason) instead of
 *   failing the whole batch on the first bad id — an operator pausing
 *   `nightly` at 03:00 should not be blocked because one automation in
 *   the group is already paused.
 * - Stats are computed from the registry + the counters: per tag, per
 *   owner, and fleet-wide. A status of `failed` means the last run
 *   failed; `running` means a run is in flight right now.
 *
 * Nothing here re-pins global counters and nothing here touches the
 * network: it is a data structure with rules.
 */

/** Lifecycle status of one automation. */
export type FleetV24AutomationStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'disabled';

/** All statuses, in dashboard display order. */
export const FLEET_V24_AUTOMATION_STATUSES: readonly FleetV24AutomationStatus[] = [
  'running',
  'failed',
  'paused',
  'idle',
  'completed',
  'disabled',
];

/** One automation tracked by the v24 dashboard. */
export interface FleetV24Automation {
  /** Stable id, unique inside the registry (e.g. `auto-nightly-backup`). */
  id: string;
  /** Human name shown in the dashboard. */
  name: string;
  /** Owner: user id, team id or service account (e.g. `team-data`). */
  owner: string;
  /** Tags, normalised to lower-case, trimmed, de-duplicated, sorted. */
  tags: string[];
  /** Current lifecycle status. */
  status: FleetV24AutomationStatus;
  /** Optional cron expression (5 fields) or free-form schedule label. */
  schedule: string | null;
  /** When the automation was registered (epoch ms). */
  createdAtMs: number;
  /** When any field last changed (epoch ms). */
  updatedAtMs: number;
  /** When the latest run started (epoch ms, null = never ran). */
  lastRunAtMs: number | null;
  /** When the latest run finished (epoch ms, null = never finished). */
  lastFinishedAtMs: number | null;
  /** Total runs started. */
  runCount: number;
  /** Runs that finished successfully. */
  successCount: number;
  /** Runs that finished with failure. */
  failureCount: number;
  /** Runs cancelled or stopped mid-flight (incl. stop-hook stops). */
  stoppedCount: number;
  /** Free-form note for the operator (e.g. why it was paused). */
  note: string | null;
}

/** Input for registering a new automation. */
export interface FleetV24RegisterAutomationInput {
  id: string;
  name: string;
  owner: string;
  tags?: string[];
  schedule?: string | null;
  note?: string | null;
}

/** One lifecycle-change audit entry (registry-local, bounded). */
export interface FleetV24AutomationAuditEntry {
  /** Monotonic sequence inside the registry. */
  seq: number;
  /** When the change happened (epoch ms). */
  atMs: number;
  /** Automation affected. */
  automationId: string;
  /** What changed: register/enable/disable/pause/resume/status/run-count. */
  action: string;
  /** Who/what made the change (user id, `system`, `stop-hook`, ...). */
  actor: string;
  /** Human-readable detail (previous → new status, reason). */
  detail: string;
}

/** Per-group / per-owner statistics. */
export interface FleetV24AutomationStats {
  /** Total automations in the group. */
  total: number;
  /** Currently running. */
  running: number;
  /** Paused by an operator. */
  paused: number;
  /** Idle, waiting for the next trigger. */
  idle: number;
  /** Last run completed successfully. */
  completed: number;
  /** Last run failed. */
  failed: number;
  /** Disabled (never scheduled). */
  disabled: number;
  /** Sum of runCount over the group. */
  runs: number;
  /** Sum of successCount over the group. */
  successes: number;
  /** Sum of failureCount over the group. */
  failures: number;
  /** Sum of stoppedCount over the group. */
  stopped: number;
  /** Success rate over finished runs (0 when nothing finished yet). */
  successRate: number;
  /** Failure rate over finished runs (0 when nothing finished yet). */
  failureRate: number;
}

/** One tag group: the tag plus its automations and stats. */
export interface FleetV24TagGroup {
  tag: string;
  automations: FleetV24Automation[];
  stats: FleetV24AutomationStats;
  /** Distinct owners inside this tag group. */
  owners: string[];
}

/** One owner slice: the owner plus their automations and stats. */
export interface FleetV24OwnerSlice {
  owner: string;
  automations: FleetV24Automation[];
  stats: FleetV24AutomationStats;
  /** Distinct tags used by this owner. */
  tags: string[];
}

/** Result of one item inside a bulk group operation. */
export interface FleetV24BulkItemResult {
  automationId: string;
  /** True when the operation changed this automation. */
  applied: boolean;
  /** Why it was skipped (`already-disabled`, `already-paused`, ...). */
  skippedReason: string | null;
}

/** Result of a bulk enable/disable/pause operation on a tag group. */
export interface FleetV24BulkGroupResult {
  tag: string;
  action: 'enable' | 'disable' | 'pause' | 'resume';
  applied: number;
  skipped: number;
  items: FleetV24BulkItemResult[];
}

/** Maximum audit entries kept per registry (oldest dropped first). */
export const FLEET_V24_AUDIT_CAP = 500;

/** Empty stats (all zeros). */
export function emptyFleetV24AutomationStats(): FleetV24AutomationStats {
  return {
    total: 0,
    running: 0,
    paused: 0,
    idle: 0,
    completed: 0,
    failed: 0,
    disabled: 0,
    runs: 0,
    successes: 0,
    failures: 0,
    stopped: 0,
    successRate: 0,
    failureRate: 0,
  };
}

/** Compute stats for any list of automations. */
export function summarizeFleetV24Automations(
  automations: readonly FleetV24Automation[],
): FleetV24AutomationStats {
  const stats = emptyFleetV24AutomationStats();
  stats.total = automations.length;
  for (const a of automations) {
    if (a.status === 'running') stats.running += 1;
    else if (a.status === 'paused') stats.paused += 1;
    else if (a.status === 'idle') stats.idle += 1;
    else if (a.status === 'completed') stats.completed += 1;
    else if (a.status === 'failed') stats.failed += 1;
    else if (a.status === 'disabled') stats.disabled += 1;
    stats.runs += a.runCount;
    stats.successes += a.successCount;
    stats.failures += a.failureCount;
    stats.stopped += a.stoppedCount;
  }
  const finished = stats.successes + stats.failures;
  stats.successRate = finished > 0 ? stats.successes / finished : 0;
  stats.failureRate = finished > 0 ? stats.failures / finished : 0;
  return stats;
}

/** Normalise one tag: trim + lower-case. Empty after trim → null. */
export function normalizeFleetV24Tag(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/** Normalise a tag list: trim, lower-case, drop empties, de-duplicate, sort. */
export function normalizeFleetV24Tags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = normalizeFleetV24Tag(raw);
    if (t !== null) seen.add(t);
  }
  return [...seen].sort();
}

/** Normalise an owner: trim. Empty after trim → null. */
export function normalizeFleetV24Owner(owner: string): string | null {
  const o = owner.trim();
  return o.length > 0 ? o : null;
}

/** Validate an automation id: non-empty, no whitespace, no `/` or `\`. */
export function validateFleetV24AutomationId(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return 'Automation id must not be empty.';
  if (/\s/.test(trimmed)) return 'Automation id must not contain whitespace.';
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return 'Automation id must not contain "/" or "\\".';
  }
  if (trimmed.length > 128) return 'Automation id must be at most 128 characters.';
  return null;
}

/** Validate a registration input; returns the first problem, or null. */
export function validateFleetV24RegisterInput(
  input: FleetV24RegisterAutomationInput,
): string | null {
  const idError = validateFleetV24AutomationId(input.id);
  if (idError !== null) return idError;
  if (input.name.trim().length === 0) return 'Automation name must not be empty.';
  if (input.name.trim().length > 200) return 'Automation name must be at most 200 characters.';
  if (normalizeFleetV24Owner(input.owner) === null) return 'Automation owner must not be empty.';
  if (input.owner.trim().length > 128) return 'Automation owner must be at most 128 characters.';
  if ((input.tags ?? []).length > 32) return 'An automation may carry at most 32 tags.';
  if (input.schedule !== undefined && input.schedule !== null && input.schedule.trim().length > 128) {
    return 'Schedule label must be at most 128 characters.';
  }
  return null;
}

/** Build a fresh automation record from a validated input. */
export function createFleetV24Automation(
  input: FleetV24RegisterAutomationInput,
  nowMs: number,
): FleetV24Automation {
  const error = validateFleetV24RegisterInput(input);
  if (error !== null) throw new Error(`Invalid automation: ${error}`);
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    owner: input.owner.trim(),
    tags: normalizeFleetV24Tags(input.tags ?? []),
    status: 'idle',
    schedule: input.schedule?.trim() ? input.schedule.trim() : null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastRunAtMs: null,
    lastFinishedAtMs: null,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    stoppedCount: 0,
    note: input.note?.trim() ? input.note.trim() : null,
  };
}

/**
 * In-memory registry of fleet automations.
 *
 * The registry is deliberately small and explicit: the host creates one
 * instance, registers automations, and hands it to the tools layer
 * (`packages/tools/src/fleetV24Tools.ts`) and to the panel builders.
 * It keeps no timers and performs no I/O.
 */
export class FleetV24AutomationRegistry {
  private readonly byId = new Map<string, FleetV24Automation>();
  private audit: FleetV24AutomationAuditEntry[] = [];
  private seq = 0;

  /** Number of automations in the registry. */
  get size(): number {
    return this.byId.size;
  }

  /** All automations, sorted by id for stable output. */
  list(): FleetV24Automation[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Look one automation up by id (undefined when absent). */
  get(id: string): FleetV24Automation | undefined {
    return this.byId.get(id.trim());
  }

  /** True when an automation with this id is registered. */
  has(id: string): boolean {
    return this.byId.has(id.trim());
  }

  /** Register a new automation. Throws on invalid input or duplicate id. */
  register(input: FleetV24RegisterAutomationInput, nowMs: number, actor = 'system'): FleetV24Automation {
    const automation = createFleetV24Automation(input, nowMs);
    if (this.byId.has(automation.id)) {
      throw new Error(`Automation "${automation.id}" is already registered.`);
    }
    this.byId.set(automation.id, automation);
    this.recordAudit(nowMs, automation.id, 'register', actor, `registered as ${automation.status}`);
    return automation;
  }

  /** Remove an automation. Returns false when the id was not registered. */
  remove(id: string, nowMs: number, actor = 'system'): boolean {
    const trimmed = id.trim();
    if (!this.byId.has(trimmed)) return false;
    this.byId.delete(trimmed);
    this.recordAudit(nowMs, trimmed, 'remove', actor, 'removed from registry');
    return true;
  }

  /**
   * Change an automation's status. Returns false when the id is unknown.
   * Moving to `running` also bumps runCount and stamps lastRunAtMs; the
   * run ledger is the source of truth for outcomes, this only mirrors the
   * counters the dashboard shows.
   */
  setStatus(
    id: string,
    status: FleetV24AutomationStatus,
    nowMs: number,
    actor = 'system',
    note?: string,
  ): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    const previous = automation.status;
    automation.status = status;
    automation.updatedAtMs = nowMs;
    if (status === 'running') {
      automation.runCount += 1;
      automation.lastRunAtMs = nowMs;
    }
    if (status === 'completed' || status === 'failed') {
      automation.lastFinishedAtMs = nowMs;
    }
    if (note !== undefined) automation.note = note.trim() ? note.trim() : null;
    this.recordAudit(nowMs, automation.id, 'status', actor, `${previous} → ${status}`);
    return true;
  }

  /** Record a finished run outcome on an automation (counters only). */
  recordRunOutcome(
    id: string,
    outcome: 'completed' | 'failed' | 'stopped',
    nowMs: number,
    actor = 'system',
  ): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    if (outcome === 'completed') {
      automation.successCount += 1;
      automation.status = 'completed';
    } else if (outcome === 'failed') {
      automation.failureCount += 1;
      automation.status = 'failed';
    } else {
      automation.stoppedCount += 1;
      automation.status = 'idle';
    }
    automation.lastFinishedAtMs = nowMs;
    automation.updatedAtMs = nowMs;
    this.recordAudit(nowMs, automation.id, 'run-outcome', actor, `run ${outcome}`);
    return true;
  }

  /** Update tags / owner / name / schedule / note of a registered automation. */
  update(
    id: string,
    patch: {
      name?: string;
      owner?: string;
      tags?: string[];
      schedule?: string | null;
      note?: string | null;
    },
    nowMs: number,
    actor = 'system',
  ): FleetV24Automation | null {
    const automation = this.byId.get(id.trim());
    if (!automation) return null;
    if (patch.name !== undefined) {
      if (patch.name.trim().length === 0) throw new Error('Automation name must not be empty.');
      automation.name = patch.name.trim();
    }
    if (patch.owner !== undefined) {
      const owner = normalizeFleetV24Owner(patch.owner);
      if (owner === null) throw new Error('Automation owner must not be empty.');
      automation.owner = owner;
    }
    if (patch.tags !== undefined) automation.tags = normalizeFleetV24Tags(patch.tags);
    if (patch.schedule !== undefined) {
      automation.schedule = patch.schedule?.trim() ? patch.schedule.trim() : null;
    }
    if (patch.note !== undefined) {
      automation.note = patch.note?.trim() ? patch.note.trim() : null;
    }
    automation.updatedAtMs = nowMs;
    this.recordAudit(nowMs, automation.id, 'update', actor, 'fields updated');
    return automation;
  }

  /** Enable one automation (disabled → idle). Returns false when unknown. */
  enable(id: string, nowMs: number, actor = 'system'): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    if (automation.status === 'disabled') {
      automation.status = 'idle';
      automation.updatedAtMs = nowMs;
      this.recordAudit(nowMs, automation.id, 'enable', actor, 'disabled → idle');
    }
    return true;
  }

  /** Disable one automation (any status → disabled). Returns false when unknown. */
  disable(id: string, nowMs: number, actor = 'system'): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    if (automation.status !== 'disabled') {
      const previous = automation.status;
      automation.status = 'disabled';
      automation.updatedAtMs = nowMs;
      this.recordAudit(nowMs, automation.id, 'disable', actor, `${previous} → disabled`);
    }
    return true;
  }

  /** Pause one automation (running/idle → paused). Returns false when unknown. */
  pause(id: string, nowMs: number, actor = 'system'): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    if (automation.status === 'running' || automation.status === 'idle') {
      const previous = automation.status;
      automation.status = 'paused';
      automation.updatedAtMs = nowMs;
      this.recordAudit(nowMs, automation.id, 'pause', actor, `${previous} → paused`);
    }
    return true;
  }

  /** Resume one paused automation (paused → idle). Returns false when unknown. */
  resume(id: string, nowMs: number, actor = 'system'): boolean {
    const automation = this.byId.get(id.trim());
    if (!automation) return false;
    if (automation.status === 'paused') {
      automation.status = 'idle';
      automation.updatedAtMs = nowMs;
      this.recordAudit(nowMs, automation.id, 'resume', actor, 'paused → idle');
    }
    return true;
  }

  // -- grouping / filtering -------------------------------------------------

  /** All distinct tags in use, sorted. */
  tags(): string[] {
    const seen = new Set<string>();
    for (const a of this.byId.values()) for (const t of a.tags) seen.add(t);
    return [...seen].sort();
  }

  /** All distinct owners, sorted. */
  owners(): string[] {
    const seen = new Set<string>();
    for (const a of this.byId.values()) seen.add(a.owner);
    return [...seen].sort();
  }

  /** Automations carrying a tag (tag normalised first). */
  byTag(tag: string): FleetV24Automation[] {
    const normalized = normalizeFleetV24Tag(tag);
    if (normalized === null) return [];
    return this.list().filter((a) => a.tags.includes(normalized));
  }

  /** Automations owned by an owner (exact match after trim). */
  byOwner(owner: string): FleetV24Automation[] {
    const normalized = normalizeFleetV24Owner(owner);
    if (normalized === null) return [];
    return this.list().filter((a) => a.owner === normalized);
  }

  /** Automations carrying a tag AND owned by an owner. */
  byTagAndOwner(tag: string, owner: string): FleetV24Automation[] {
    const normalizedTag = normalizeFleetV24Tag(tag);
    const normalizedOwner = normalizeFleetV24Owner(owner);
    if (normalizedTag === null || normalizedOwner === null) return [];
    return this.list().filter((a) => a.tags.includes(normalizedTag) && a.owner === normalizedOwner);
  }

  /** Automations in one status. */
  byStatus(status: FleetV24AutomationStatus): FleetV24Automation[] {
    return this.list().filter((a) => a.status === status);
  }

  /** Automations whose last run failed (status failed), sorted by recency. */
  failed(): FleetV24Automation[] {
    return this.byStatus('failed').sort(
      (a, b) => (b.lastFinishedAtMs ?? 0) - (a.lastFinishedAtMs ?? 0),
    );
  }

  /** Automations currently running, sorted by start time (oldest first). */
  running(): FleetV24Automation[] {
    return this.byStatus('running').sort(
      (a, b) => (a.lastRunAtMs ?? 0) - (b.lastRunAtMs ?? 0),
    );
  }

  /** Group every automation by tag. Untagged automations go under `(untagged)`. */
  groupByTag(): FleetV24TagGroup[] {
    const groups = new Map<string, FleetV24Automation[]>();
    for (const a of this.list()) {
      if (a.tags.length === 0) {
        const bucket = groups.get('(untagged)') ?? [];
        bucket.push(a);
        groups.set('(untagged)', bucket);
      } else {
        for (const t of a.tags) {
          const bucket = groups.get(t) ?? [];
          bucket.push(a);
          groups.set(t, bucket);
        }
      }
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, automations]) => ({
        tag,
        automations,
        stats: summarizeFleetV24Automations(automations),
        owners: [...new Set(automations.map((a) => a.owner))].sort(),
      }));
  }

  /** Slice every automation by owner. */
  groupByOwner(): FleetV24OwnerSlice[] {
    const groups = new Map<string, FleetV24Automation[]>();
    for (const a of this.list()) {
      const bucket = groups.get(a.owner) ?? [];
      bucket.push(a);
      groups.set(a.owner, bucket);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([owner, automations]) => ({
        owner,
        automations,
        stats: summarizeFleetV24Automations(automations),
        tags: [...new Set(automations.flatMap((a) => a.tags))].sort(),
      }));
  }

  /** Stats for one tag (empty stats when the tag is unused). */
  statsByTag(tag: string): FleetV24AutomationStats {
    return summarizeFleetV24Automations(this.byTag(tag));
  }

  /** Stats for one owner (empty stats when the owner has nothing). */
  statsByOwner(owner: string): FleetV24AutomationStats {
    return summarizeFleetV24Automations(this.byOwner(owner));
  }

  /** Fleet-wide stats. */
  stats(): FleetV24AutomationStats {
    return summarizeFleetV24Automations(this.list());
  }

  // -- bulk group operations ------------------------------------------------

  /**
   * Enable every automation carrying a tag. Already-enabled automations
   * are reported as skipped (`already-enabled`); unknown ids cannot
   * happen here because the group is read from the registry itself.
   */
  enableTag(tag: string, nowMs: number, actor = 'system'): FleetV24BulkGroupResult {
    const normalized = normalizeFleetV24Tag(tag);
    const group = normalized === null ? [] : this.byTag(normalized);
    const items: FleetV24BulkItemResult[] = [];
    for (const a of group) {
      if (a.status === 'disabled') {
        this.enable(a.id, nowMs, actor);
        items.push({ automationId: a.id, applied: true, skippedReason: null });
      } else {
        items.push({ automationId: a.id, applied: false, skippedReason: 'already-enabled' });
      }
    }
    return this.bulkResult(normalized ?? tag, 'enable', items);
  }

  /** Disable every automation carrying a tag. */
  disableTag(tag: string, nowMs: number, actor = 'system'): FleetV24BulkGroupResult {
    const normalized = normalizeFleetV24Tag(tag);
    const group = normalized === null ? [] : this.byTag(normalized);
    const items: FleetV24BulkItemResult[] = [];
    for (const a of group) {
      if (a.status === 'disabled') {
        items.push({ automationId: a.id, applied: false, skippedReason: 'already-disabled' });
      } else {
        this.disable(a.id, nowMs, actor);
        items.push({ automationId: a.id, applied: true, skippedReason: null });
      }
    }
    return this.bulkResult(normalized ?? tag, 'disable', items);
  }

  /** Pause every running/idle automation carrying a tag. */
  pauseTag(tag: string, nowMs: number, actor = 'system'): FleetV24BulkGroupResult {
    const normalized = normalizeFleetV24Tag(tag);
    const group = normalized === null ? [] : this.byTag(normalized);
    const items: FleetV24BulkItemResult[] = [];
    for (const a of group) {
      if (a.status === 'running' || a.status === 'idle') {
        this.pause(a.id, nowMs, actor);
        items.push({ automationId: a.id, applied: true, skippedReason: null });
      } else if (a.status === 'paused') {
        items.push({ automationId: a.id, applied: false, skippedReason: 'already-paused' });
      } else {
        items.push({
          automationId: a.id,
          applied: false,
          skippedReason: `cannot-pause-from-${a.status}`,
        });
      }
    }
    return this.bulkResult(normalized ?? tag, 'pause', items);
  }

  /** Resume every paused automation carrying a tag. */
  resumeTag(tag: string, nowMs: number, actor = 'system'): FleetV24BulkGroupResult {
    const normalized = normalizeFleetV24Tag(tag);
    const group = normalized === null ? [] : this.byTag(normalized);
    const items: FleetV24BulkItemResult[] = [];
    for (const a of group) {
      if (a.status === 'paused') {
        this.resume(a.id, nowMs, actor);
        items.push({ automationId: a.id, applied: true, skippedReason: null });
      } else {
        items.push({ automationId: a.id, applied: false, skippedReason: 'not-paused' });
      }
    }
    return this.bulkResult(normalized ?? tag, 'resume', items);
  }

  private bulkResult(
    tag: string,
    action: FleetV24BulkGroupResult['action'],
    items: FleetV24BulkItemResult[],
  ): FleetV24BulkGroupResult {
    return {
      tag,
      action,
      applied: items.filter((i) => i.applied).length,
      skipped: items.filter((i) => !i.applied).length,
      items,
    };
  }

  // -- audit -----------------------------------------------------------------

  private recordAudit(
    atMs: number,
    automationId: string,
    action: string,
    actor: string,
    detail: string,
  ): void {
    this.seq += 1;
    this.audit.push({ seq: this.seq, atMs, automationId, action, actor, detail });
    if (this.audit.length > FLEET_V24_AUDIT_CAP) {
      this.audit.splice(0, this.audit.length - FLEET_V24_AUDIT_CAP);
    }
  }

  /** Audit trail, newest first. Pass a limit to trim (default 100). */
  auditTrail(limit = 100): FleetV24AutomationAuditEntry[] {
    return [...this.audit].reverse().slice(0, Math.max(0, limit));
  }

  /** Audit entries for one automation, newest first. */
  auditFor(automationId: string, limit = 50): FleetV24AutomationAuditEntry[] {
    const trimmed = automationId.trim();
    return [...this.audit]
      .reverse()
      .filter((e) => e.automationId === trimmed)
      .slice(0, Math.max(0, limit));
  }
}

/** Create an empty registry. */
export function createFleetV24AutomationRegistry(): FleetV24AutomationRegistry {
  return new FleetV24AutomationRegistry();
}
