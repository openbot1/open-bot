/**
 * Protocols v10 — deprecation policy registry (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): the MCP spec
 * 2026-07-28 fixes a deprecation policy — a deprecated
 * feature stays for at least 12 months before it may be
 * removed, and only an actively exploited security flaw
 * shortens that to 90 days. This module is open-bot's own
 * implementation of that policy as a registry the whole
 * codebase can consult before removing anything:
 *
 *   - `McpV10DeprecationRegistry`: register a deprecated
 *     feature with the date it was deprecated, why, what
 *     replaces it, and whether a security flaw forces the
 *     short window. The registry computes the earliest
 *     removal date (deprecated + 12 months, or + 90 days
 *     for a security flaw) and refuses to mark a feature
 *     removed before that date.
 *   - `recordUse()`: every use of a deprecated feature is
 *     counted (and optionally logged with a warning), so the
 *     team can see what still depends on it before the
 *     removal date arrives.
 *   - `checkRemoval()`: the removal guard — removing a
 *     feature requires the registry to say the window has
 *     passed; otherwise the removal is refused with the
 *     remaining days spelled out.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no disk: the registry is in-memory; the host
 * mirrors snapshots.
 */

import {
  MCP_V10_DEPRECATION_MONTHS,
  MCP_V10_DEPRECATION_SECURITY_DAYS,
} from './versionsV10';

/** Error raised by the deprecation registry. */
export class McpV10DeprecationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10DeprecationError';
    this.code = code;
  }
}

/** Why a feature was deprecated. */
export const MCP_V10_DEPRECATION_REASONS = [
  'replaced',
  'security',
  'spec-removed',
  'unused',
] as const;
export type McpV10DeprecationReason = (typeof MCP_V10_DEPRECATION_REASONS)[number];

/** Status of a registered feature. */
export const MCP_V10_DEPRECATION_STATUSES = ['active', 'deprecated', 'removed'] as const;
export type McpV10DeprecationStatus = (typeof MCP_V10_DEPRECATION_STATUSES)[number];

/** One registered feature (deprecated or removed). */
export interface McpV10DeprecationEntry {
  /** Feature id, e.g. `mcp.initialize` or `oauth.dcr`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Current status. */
  status: McpV10DeprecationStatus;
  /** Why it was deprecated. */
  reason: McpV10DeprecationReason;
  /** Date it was deprecated (ISO `YYYY-MM-DD`). */
  deprecatedSince: string;
  /** What replaces it (undefined when nothing does). */
  replacedBy?: string;
  /** True when an actively exploited security flaw forces the 90-day window. */
  securityFlaw: boolean;
  /** Earliest removal date (ISO `YYYY-MM-DD`), computed from the policy. */
  earliestRemoval: string;
  /** Date it was actually removed (removed entries only). */
  removedAt?: string;
  /** How many times the deprecated feature was used since deprecation. */
  useCount: number;
  /** When it was last used (ms since epoch, undefined when never). */
  lastUsedAtMs?: number;
  /** Migration note for users of the feature. */
  migrationNote?: string;
}

function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * Compute the earliest removal date for a deprecation:
 * deprecated + 12 months normally, + 90 days when an
 * actively exploited security flaw forces the short window.
 */
export function mcpV10EarliestRemovalDate(
  deprecatedSince: string,
  securityFlaw: boolean,
): string {
  if (securityFlaw) return addDays(deprecatedSince, MCP_V10_DEPRECATION_SECURITY_DAYS);
  return addMonths(deprecatedSince, MCP_V10_DEPRECATION_MONTHS);
}

/** Validate a deprecation date (`YYYY-MM-DD`, real calendar date). */
export function isMcpV10ValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Days from `from` (ISO date) to `to` (ISO date); negative when past. */
export function mcpV10DaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Today as an ISO date (UTC). */
export function mcpV10TodayIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The deprecation registry: the single place that knows
 * what is deprecated, when it may be removed, and what
 * still uses it.
 */
export class McpV10DeprecationRegistry {
  private readonly entries = new Map<string, McpV10DeprecationEntry>();

  /** Register a deprecation (replaces any entry with the same id). */
  deprecate(input: {
    id: string;
    name: string;
    reason: McpV10DeprecationReason;
    deprecatedSince: string;
    replacedBy?: string;
    securityFlaw?: boolean;
    migrationNote?: string;
  }): McpV10DeprecationEntry {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new McpV10DeprecationError('invalid-entry', 'Deprecation id must be a non-empty string.');
    }
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new McpV10DeprecationError('invalid-entry', 'Deprecation name must be a non-empty string.');
    }
    if (!(MCP_V10_DEPRECATION_REASONS as readonly string[]).includes(input.reason)) {
      throw new McpV10DeprecationError(
        'invalid-entry',
        `Deprecation reason must be one of ${MCP_V10_DEPRECATION_REASONS.join(', ')}.`,
      );
    }
    if (!isMcpV10ValidDate(input.deprecatedSince)) {
      throw new McpV10DeprecationError('invalid-entry', `deprecatedSince "${input.deprecatedSince}" is not a valid YYYY-MM-DD date.`);
    }
    const securityFlaw = input.securityFlaw === true;
    if (securityFlaw && input.reason !== 'security') {
      throw new McpV10DeprecationError(
        'invalid-entry',
        'The 90-day security window applies only when reason is "security" (an actively exploited flaw).',
      );
    }
    const entry: McpV10DeprecationEntry = {
      id: input.id,
      name: input.name,
      status: 'deprecated',
      reason: input.reason,
      deprecatedSince: input.deprecatedSince,
      replacedBy: input.replacedBy,
      securityFlaw,
      earliestRemoval: mcpV10EarliestRemovalDate(input.deprecatedSince, securityFlaw),
      useCount: 0,
      migrationNote: input.migrationNote,
    };
    this.entries.set(input.id, entry);
    return { ...entry };
  }

  /** Get one entry (copy; undefined when unknown). */
  get(id: string): McpV10DeprecationEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  /** All entries (copies), sorted by earliest removal date. */
  list(): McpV10DeprecationEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.earliestRemoval < b.earliestRemoval ? -1 : a.earliestRemoval > b.earliestRemoval ? 1 : a.id < b.id ? -1 : 1))
      .map((e) => ({ ...e }));
  }

  /** Entries in one status. */
  listByStatus(status: McpV10DeprecationStatus): McpV10DeprecationEntry[] {
    return this.list().filter((e) => e.status === status);
  }

  /** Entries whose removal window has passed (removable now). */
  removableNow(todayIso = mcpV10TodayIso()): McpV10DeprecationEntry[] {
    return this.listByStatus('deprecated').filter((e) => mcpV10DaysBetween(todayIso, e.earliestRemoval) <= 0);
  }

  /** Entries still inside their removal window (not removable yet). */
  pending(todayIso = mcpV10TodayIso()): Array<McpV10DeprecationEntry & { daysLeft: number }> {
    return this.listByStatus('deprecated')
      .filter((e) => mcpV10DaysBetween(todayIso, e.earliestRemoval) > 0)
      .map((e) => ({ ...e, daysLeft: mcpV10DaysBetween(todayIso, e.earliestRemoval) }));
  }

  /**
   * Record one use of a deprecated feature (the caller logs
   * a warning; the registry only counts). Returns the new
   * use count. Using a removed feature throws.
   */
  recordUse(id: string, nowMs = Date.now()): number {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new McpV10DeprecationError('unknown-feature', `No deprecation entry for "${id}".`);
    }
    if (entry.status === 'removed') {
      throw new McpV10DeprecationError('removed', `Feature "${id}" was removed on ${entry.removedAt}; it must not be used.`);
    }
    entry.useCount += 1;
    entry.lastUsedAtMs = nowMs;
    return entry.useCount;
  }

  /**
   * The removal guard: remove a feature only when its
   * window has passed. Returns problems (empty when the
   * removal is allowed); the caller performs the removal
   * via `remove()` after the guard passes.
   */
  checkRemoval(id: string, todayIso = mcpV10TodayIso()): string[] {
    const entry = this.entries.get(id);
    if (!entry) return [`No deprecation entry for "${id}".`];
    if (entry.status === 'removed') return [`Feature "${id}" is already removed (on ${entry.removedAt}).`];
    const daysLeft = mcpV10DaysBetween(todayIso, entry.earliestRemoval);
    if (daysLeft > 0) {
      return [
        `Feature "${id}" cannot be removed yet: the deprecation policy keeps it for ${entry.securityFlaw ? '90 days (security flaw)' : '12 months'} after ${entry.deprecatedSince} (earliest removal ${entry.earliestRemoval}, ${daysLeft} day(s) left).`,
      ];
    }
    if (entry.useCount > 0) {
      return [
        `Feature "${id}" may be removed (window passed on ${entry.earliestRemoval}) but it was still used ${entry.useCount} time(s) since deprecation — confirm no caller depends on it before removing.`,
      ];
    }
    return [];
  }

  /**
   * Remove a feature (the guard must pass first, except
   * when the caller explicitly overrides with a reason —
   * the override is recorded in the migration note).
   */
  remove(id: string, todayIso = mcpV10TodayIso(), overrideReason?: string): McpV10DeprecationEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new McpV10DeprecationError('unknown-feature', `No deprecation entry for "${id}".`);
    const problems = this.checkRemoval(id, todayIso);
    const blocking = problems.filter((p) => !p.includes('may be removed'));
    if (blocking.length > 0 && !overrideReason) {
      throw new McpV10DeprecationError('removal-blocked', blocking.join(' '));
    }
    entry.status = 'removed';
    entry.removedAt = todayIso;
    if (overrideReason) {
      entry.migrationNote = `${entry.migrationNote ?? ''} [Removal override: ${overrideReason}]`.trim();
    }
    return { ...entry };
  }

  /** Serialisable snapshot (for the host to mirror). */
  snapshot(): McpV10DeprecationEntry[] {
    return this.list();
  }

  /** Restore from a snapshot (replaces the whole registry). */
  restore(entries: readonly McpV10DeprecationEntry[]): void {
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.id, { ...entry });
  }
}

/** The v10 deprecations open-bot ships with (registered by the host at startup). */
export function defaultMcpV10Deprecations(): Array<{
  id: string;
  name: string;
  reason: McpV10DeprecationReason;
  deprecatedSince: string;
  replacedBy?: string;
  securityFlaw?: boolean;
  migrationNote?: string;
}> {
  return [
    {
      id: 'mcp.initialize',
      name: 'MCP initialize handshake',
      reason: 'replaced',
      deprecatedSince: '2026-07-28',
      replacedBy: 'server/discover (stateless, no session)',
      migrationNote: 'Use McpV10StatelessClient.discover() instead of initialize; pass protocol version + capabilities in _meta.',
    },
    {
      id: 'mcp.session-id-header',
      name: 'Mcp-Session-Id header',
      reason: 'replaced',
      deprecatedSince: '2026-07-28',
      replacedBy: 'State handles passed back as plain tool arguments',
      migrationNote: 'Servers that need state issue a state handle; clients pass it back as the state_handle argument.',
    },
    {
      id: 'oauth.dcr',
      name: 'Dynamic Client Registration',
      reason: 'replaced',
      deprecatedSince: '2026-07-28',
      replacedBy: 'Explicit registration / Client ID Metadata Documents',
      migrationNote: 'Register clients explicitly or publish a Client ID Metadata Document; see oauthV10.ts.',
    },
    {
      id: 'mcp.sampling-callback',
      name: 'Server-initiated sampling / elicitation callbacks',
      reason: 'replaced',
      deprecatedSince: '2026-07-28',
      replacedBy: 'Multi round-trip input_required results',
      migrationNote: 'Servers answer input_required; clients retry with the answer (see multiRoundTripV10.ts).',
    },
    {
      id: 'mcp.per-kind-notifications',
      name: 'Per-kind change notifications',
      reason: 'replaced',
      deprecatedSince: '2026-07-28',
      replacedBy: 'One opt-in subscriptions/listen stream',
      migrationNote: 'Subscribe to kinds on subscriptions/listen; no listener means no push.',
    },
  ];
}
