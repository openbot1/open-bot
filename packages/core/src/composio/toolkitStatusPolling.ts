/**
 * Composio toolkit-status polling (v1.08, Đội T4).
 *
 * Different from the app-event polling in polling.ts / pollScheduler.ts:
 * that polls for NEW ITEMS (mail, issues, messages) inside a toolkit.
 * This polls for the CONNECTION STATUS of each toolkit itself —
 * `active` / `initiated` / `none` as reported by
 * `COMPOSIO_MANAGE_CONNECTIONS` — on a schedule, and reports when a
 * toolkit's status CHANGES (a connected account was revoked, an OAuth
 * flow expired, a new account was linked...).
 *
 * Why it exists: a toolkit that silently loses its connection makes
 * every later tool call fail with a confusing error. Polling status
 * turns that into a visible event the UI (and the health dashboard)
 * can show: "Slack disconnected 20 minutes ago".
 *
 * Rules (same as the rest of the Composio layer):
 * - NO direct Composio API call and NO key here: the host injects
 *   `fetchStatuses` (in production: the router's
 *   `COMPOSIO_MANAGE_CONNECTIONS` result mapped to
 *   `ComposioToolkitConnection[]`; in tests: a stub). The poller only
 *   diffs what it is given.
 * - The first poll establishes the BASELINE silently — it reports no
 *   changes, so a fresh start does not spam "everything changed".
 *   Later polls diff against the last seen status per toolkit.
 * - A status change OR an account-label change (same status, different
 *   linked account) both count as a change.
 * - Poll errors (network, session expired) are recorded on the poll
 *   result with backoff (same constants as pollScheduler.ts) — they
 *   never crash the timer and never wipe the last known statuses.
 * - Only the toolkits in `toolkits` are watched (default: every known
 *   toolkit slug). The host passes the ENABLED subset here — a
 *   disabled toolkit is simply not polled (see toolkitConnections.ts).
 * - Timer is a `setTimeout` chain with `unref` (same shape as
 *   ComposioPollScheduler) — monitoring never keeps the process alive.
 */

import {
  COMPOSIO_POLL_BACKOFF_MAX_MS,
  COMPOSIO_POLL_BACKOFF_MULTIPLIER,
  clampComposioPollIntervalMs,
  composioPollBackoffDelayMs,
} from './pollScheduler';
import { COMPOSIO_TOOLKIT_SLUGS } from './toolkits';
import type { ComposioConnectionStatus, ComposioToolkitConnection } from './types';

/** Default status-poll interval: 15 minutes (status changes slowly). */
export const COMPOSIO_TOOLKIT_STATUS_POLL_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** Minimum status-poll interval: 1 minute (shorter burns quota for nothing). */
export const COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS = 60 * 1000;
/** Maximum status-poll interval: 24 hours. */
export const COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Change log kept in memory (ring buffer — oldest changes drop). */
export const COMPOSIO_TOOLKIT_STATUS_POLL_MAX_CHANGES = 200;

/** Host-injected status fetch (router result, or a stub in tests). */
export type ComposioToolkitStatusFetchFn = () => Promise<ComposioToolkitConnection[]>;

/** One detected change: a toolkit's connection status (or account) moved. */
export interface ComposioToolkitStatusChange {
  /** Toolkit slug, e.g. 'gmail'. */
  toolkit: string;
  /** Status before this poll. */
  from: ComposioConnectionStatus;
  /** Status after this poll. */
  to: ComposioConnectionStatus;
  /** ms epoch when the change was observed. */
  atMs: number;
  /** Linked-account label after the change (only when status is 'active'). */
  accountLabel?: string;
  /** Linked-account label before the change (when it changed). */
  previousAccountLabel?: string;
}

/** Result of one status poll. */
export interface ComposioToolkitStatusPollResult {
  /** ms epoch of this poll. */
  polledAtMs: number;
  /** Toolkits whose status was compared this poll. */
  checked: number;
  /** Changes found this poll (empty on the baseline poll). */
  changes: ComposioToolkitStatusChange[];
  /** Error text when the fetch failed (changes empty, old statuses kept). */
  error?: string;
}

/** Last-known status of one watched toolkit (for the UI). */
export interface ComposioToolkitStatusEntry {
  toolkit: string;
  status: ComposioConnectionStatus;
  accountLabel?: string;
  lastChangedAtMs?: number;
  /** True once this toolkit has been polled at least once. */
  seen: boolean;
}

export interface ComposioToolkitStatusPollerOptions {
  /** Host-injected fetch (required — the poller never calls Composio itself). */
  fetchStatuses: ComposioToolkitStatusFetchFn;
  /** Toolkit slugs to watch (default: every known toolkit). Unknown slugs are ignored. */
  toolkits?: string[];
  /** Poll interval, ms (default 15 min; clamped to 1 min – 24 h). */
  intervalMs?: number;
  /** Clock, injectable for tests (defaults to Date.now). */
  now?: () => number;
  /** Called with each poll's changes (empty array on the baseline poll — not called then). */
  onChanges?: (changes: ComposioToolkitStatusChange[]) => void;
  /** Change log capacity (default 200). */
  maxChanges?: number;
}

export interface ComposioToolkitStatusPollerStatus {
  running: boolean;
  intervalMs: number;
  watchedToolkits: string[];
  lastPolledAtMs: number;
  lastError?: string;
  consecutiveFailures: number;
  nextPollAtMs: number;
  totalPolls: number;
  totalChanges: number;
  toolkits: ComposioToolkitStatusEntry[];
}

function normalizeToolkitList(toolkits: string[] | undefined): string[] {
  const known = new Set<string>(COMPOSIO_TOOLKIT_SLUGS as readonly string[]);
  const wanted = toolkits === undefined ? [...COMPOSIO_TOOLKIT_SLUGS] : toolkits;
  const out: string[] = [];
  for (const slug of wanted) {
    if (typeof slug !== 'string') continue;
    const trimmed = slug.trim();
    if (trimmed !== '' && known.has(trimmed) && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export class ComposioToolkitStatusPoller {
  private readonly fetchStatuses: ComposioToolkitStatusFetchFn;
  private readonly now: () => number;
  private readonly onChanges?: (changes: ComposioToolkitStatusChange[]) => void;
  private readonly maxChanges: number;
  private toolkits: string[];
  private intervalMs: number;
  private readonly lastKnown = new Map<string, ComposioToolkitConnection>();
  private readonly lastChangedAt = new Map<string, number>();
  private readonly changes: ComposioToolkitStatusChange[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerStopped = true;
  private lastPolledAtMs = 0;
  private lastError?: string;
  private consecutiveFailures = 0;
  private nextPollAtMs = 0;
  private totalPolls = 0;
  private totalChanges = 0;
  private baselineDone = false;

  constructor(options: ComposioToolkitStatusPollerOptions) {
    if (typeof options.fetchStatuses !== 'function') {
      throw new Error('ComposioToolkitStatusPoller needs a fetchStatuses function.');
    }
    this.fetchStatuses = options.fetchStatuses;
    this.now = options.now ?? Date.now;
    this.onChanges = options.onChanges;
    const maxChanges = options.maxChanges ?? COMPOSIO_TOOLKIT_STATUS_POLL_MAX_CHANGES;
    this.maxChanges = Number.isFinite(maxChanges) && maxChanges >= 1 ? Math.floor(maxChanges) : COMPOSIO_TOOLKIT_STATUS_POLL_MAX_CHANGES;
    this.toolkits = normalizeToolkitList(options.toolkits);
    this.intervalMs = clampComposioPollIntervalMs(
      options.intervalMs ?? COMPOSIO_TOOLKIT_STATUS_POLL_DEFAULT_INTERVAL_MS,
    );
    if (this.intervalMs < COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS) {
      this.intervalMs = COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS;
    }
    if (this.intervalMs > COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS) {
      this.intervalMs = COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS;
    }
  }

  /** Poll once now. Returns the changes found (empty on the baseline poll or on error). Never throws for a fetch failure — that IS the result. */
  async pollNow(): Promise<ComposioToolkitStatusPollResult> {
    const polledAtMs = this.now();
    let fetched: ComposioToolkitConnection[];
    try {
      fetched = await this.fetchStatuses();
    } catch (err) {
      this.consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.lastPolledAtMs = polledAtMs;
      this.totalPolls += 1;
      this.nextPollAtMs =
        polledAtMs +
        composioPollBackoffDelayMs(
          this.intervalMs,
          this.consecutiveFailures,
          COMPOSIO_POLL_BACKOFF_MAX_MS,
          COMPOSIO_POLL_BACKOFF_MULTIPLIER,
        );
      return { polledAtMs, checked: 0, changes: [], error: message };
    }
    if (!Array.isArray(fetched)) {
      this.consecutiveFailures += 1;
      this.lastError = 'fetchStatuses did not return a list';
      this.lastPolledAtMs = polledAtMs;
      this.totalPolls += 1;
      return { polledAtMs, checked: 0, changes: [], error: this.lastError };
    }
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.lastPolledAtMs = polledAtMs;
    this.totalPolls += 1;
    this.nextPollAtMs = polledAtMs + this.intervalMs;
    const watched = new Set(this.toolkits);
    const byToolkit = new Map<string, ComposioToolkitConnection>();
    for (const entry of fetched) {
      if (!entry || typeof entry.toolkit !== 'string') continue;
      if (!watched.has(entry.toolkit)) continue;
      byToolkit.set(entry.toolkit, entry);
    }
    const changes: ComposioToolkitStatusChange[] = [];
    let checked = 0;
    for (const toolkit of this.toolkits) {
      const current = byToolkit.get(toolkit);
      // A toolkit missing from the fetch result keeps its last known
      // status (the router only reports toolkits in the session) — it
      // is not treated as 'none' on a silent miss.
      if (!current) continue;
      checked += 1;
      const previous = this.lastKnown.get(toolkit);
      this.lastKnown.set(toolkit, { ...current });
      if (!this.baselineDone) continue;
      if (!previous) continue;
      const statusChanged = previous.status !== current.status;
      const labelChanged =
        current.status === 'active' && previous.accountLabel !== current.accountLabel;
      if (!statusChanged && !labelChanged) continue;
      const change: ComposioToolkitStatusChange = {
        toolkit,
        from: previous.status,
        to: current.status,
        atMs: polledAtMs,
        ...(current.accountLabel !== undefined ? { accountLabel: current.accountLabel } : {}),
        ...(labelChanged && previous.accountLabel !== undefined
          ? { previousAccountLabel: previous.accountLabel }
          : {}),
      };
      changes.push(change);
      this.lastChangedAt.set(toolkit, polledAtMs);
    }
    // The baseline poll only records statuses, never reports changes.
    if (!this.baselineDone) this.baselineDone = true;
    if (changes.length > 0) {
      this.changes.push(...changes);
      if (this.changes.length > this.maxChanges) {
        this.changes.splice(0, this.changes.length - this.maxChanges);
      }
      this.totalChanges += changes.length;
      this.onChanges?.(changes.map((c) => ({ ...c })));
    }
    return { polledAtMs, checked, changes: changes.map((c) => ({ ...c })) };
  }

  /** Start periodic polling (default interval from the constructor). Safe to call twice — restarts the timer. */
  start(): void {
    this.stop();
    this.timerStopped = false;
    this.scheduleNext();
  }

  /** Stop periodic polling (an in-flight poll still finishes). */
  stop(): void {
    this.timerStopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** True while the periodic timer is armed. */
  isRunning(): boolean {
    return !this.timerStopped;
  }

  /** Change the poll interval (clamped to 1 min – 24 h). Applies to the next scheduled poll. */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = clampComposioPollIntervalMs(intervalMs);
    if (this.intervalMs < COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS) {
      this.intervalMs = COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS;
    }
    if (this.intervalMs > COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS) {
      this.intervalMs = COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS;
    }
  }

  /** Change the watched toolkit list (unknown slugs ignored; statuses of dropped toolkits are forgotten). */
  setToolkits(toolkits: string[]): void {
    this.toolkits = normalizeToolkitList(toolkits);
    for (const slug of [...this.lastKnown.keys()]) {
      if (!this.toolkits.includes(slug)) {
        this.lastKnown.delete(slug);
        this.lastChangedAt.delete(slug);
      }
    }
  }

  /** Newest-first change log (up to `limit`, default 50). */
  getChanges(limit = 50): ComposioToolkitStatusChange[] {
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50;
    return [...this.changes].slice(-safeLimit).reverse().map((c) => ({ ...c }));
  }

  /** Last poll result summary + last-known status per watched toolkit (for the UI). */
  getStatus(): ComposioToolkitStatusPollerStatus {
    return {
      running: this.isRunning(),
      intervalMs: this.intervalMs,
      watchedToolkits: [...this.toolkits],
      lastPolledAtMs: this.lastPolledAtMs,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.consecutiveFailures,
      nextPollAtMs: this.nextPollAtMs,
      totalPolls: this.totalPolls,
      totalChanges: this.totalChanges,
      toolkits: this.toolkits.map((toolkit) => {
        const known = this.lastKnown.get(toolkit);
        const entry: ComposioToolkitStatusEntry = {
          toolkit,
          status: known?.status ?? 'none',
          seen: known !== undefined,
        };
        if (known?.accountLabel !== undefined) entry.accountLabel = known.accountLabel;
        const changedAt = this.lastChangedAt.get(toolkit);
        if (changedAt !== undefined) entry.lastChangedAtMs = changedAt;
        return entry;
      }),
    };
  }

  private scheduleNext(): void {
    if (this.timerStopped) return;
    const delay =
      this.nextPollAtMs > 0
        ? Math.max(0, this.nextPollAtMs - this.now())
        : this.intervalMs;
    this.timer = setTimeout(() => {
      void this.pollNow()
        .catch(() => undefined)
        .finally(() => this.scheduleNext());
    }, delay);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as unknown as { unref(): void }).unref();
    }
  }
}
