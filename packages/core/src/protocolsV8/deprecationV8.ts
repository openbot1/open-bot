/**
 * Protocols v8 — deprecation handling (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1): SEP-2577 deprecates
 * Sampling, Roots and Logging — they still run, must not be
 * adopted by new code, and are earliest removed in the
 * revision after 2027-07-28. The `initialize` handshake, the
 * `Mcp-Session-Id` header and HTTP+SSE transport are
 * superseded by the stateless core (server/discover +
 * Streamable HTTP) on the same timeline.
 *
 * This module is open-bot's own deprecation layer, written
 * from that description:
 *
 *   - `McpV8DeprecationTracker`: records every use of a
 *     deprecated feature (feature, caller, timestamp),
 *     emits a structured warning per use, and reports counts
 *     so the UI can show "this integration still uses X".
 *   - `mcpV8MigrationPlan(feature)`: a concrete, ordered
 *     migration plan per feature (what to stop calling, what
 *     to call instead, how to verify).
 *   - `McpV8TransportPolicy`: prefers Streamable HTTP,
 *     warns on HTTP+SSE, refuses nothing (deprecated
 *     features still run until the removal floor) — but the
 *     policy object makes the preference explicit and
 *     testable, and `removalStatus(nowMs)` tells the caller
 *     how many days remain before the floor.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  MCP_V8_DEPRECATIONS,
  MCP_V8_LEGACY_REMOVAL_DATE,
  mcpV8DeprecationByFeature,
  mcpV8IsDeprecated,
  type McpV8DeprecationEntry,
} from './versionsV8';

/** A structured deprecation warning (one per deprecated use). */
export interface McpV8DeprecationWarning {
  /** Deprecated feature used. */
  feature: string;
  /** Who used it (caller label supplied by the host). */
  caller: string;
  /** When (ms since epoch). */
  atMs: number;
  /** What to use instead. */
  replacement: string;
  /** Earliest removal date. */
  earliestRemoval: string;
  /** Full human-readable message. */
  message: string;
}

/** One migration step. */
export interface McpV8MigrationStep {
  /** Step number (1-based). */
  step: number;
  /** What to do. */
  action: string;
  /** How to verify the step worked. */
  verify: string;
}

/** A migration plan for one deprecated feature. */
export interface McpV8MigrationPlan {
  feature: string;
  deprecatedOn: string;
  earliestRemoval: string;
  replacement: string;
  steps: McpV8MigrationStep[];
  /** True when the feature is already past its removal floor at the plan date. */
  pastRemovalFloor: boolean;
}

/** Migration plans, one per deprecated feature. */
const MCP_V8_MIGRATION_STEPS: Record<string, McpV8MigrationStep[]> = {
  sampling: [
    {
      step: 1,
      action: 'Stop calling sampling/createMessage: remove the sampling capability from the client advertisement.',
      verify: 'The client capabilities no longer list sampling; the server never receives a sampling request.',
    },
    {
      step: 2,
      action: 'Move user input to Elicitation (form / URL modes): the host asks the user through elicitation instead of asking the model to sample.',
      verify: 'User input arrives through elicitation callbacks; no sampling round-trip is opened.',
    },
    {
      step: 3,
      action: 'Let the model choose sampling parameters locally (temperature, top-p) instead of negotiating them over the wire.',
      verify: 'Model calls carry no sampling negotiation; outputs are unchanged for the same prompts.',
    },
  ],
  roots: [
    {
      step: 1,
      action: 'Stop advertising roots/list: remove the roots capability from the client advertisement.',
      verify: 'The client capabilities no longer list roots; the server never asks for roots.',
    },
    {
      step: 2,
      action: 'Pass explicit resource URIs and tool arguments instead of filesystem roots.',
      verify: 'Every file access names its resource URI; no tool call depends on a root prefix.',
    },
    {
      step: 3,
      action: 'Remove root-based path resolution from the host (no more "inside root X" checks).',
      verify: 'The host path resolver takes absolute resource URIs only.',
    },
  ],
  logging: [
    {
      step: 1,
      action: 'Stop sending logging/setLevel and stop listening for notifications/message (logging channel).',
      verify: 'No logging/setLevel call is issued; the logging notification handler is removed.',
    },
    {
      step: 2,
      action: 'Move diagnostics to host-side structured logging (the app log, not the protocol).',
      verify: 'Errors and diagnostics appear in the host log with the same detail as before.',
    },
    {
      step: 3,
      action: 'Remove the logging level state from the client (no per-session log level).',
      verify: 'The client holds no log-level state between requests.',
    },
  ],
  'http-sse-transport': [
    {
      step: 1,
      action: 'Switch the transport to Streamable HTTP: one POST per request, optional SSE stream only for the response.',
      verify: 'Requests go to the Streamable HTTP endpoint; no long-lived SSE GET is opened.',
    },
    {
      step: 2,
      action: 'Drop the SSE reconnect / resume logic (no Last-Event-ID handling).',
      verify: 'The client has no SSE reconnect code path.',
    },
    {
      step: 3,
      action: 'Verify the server answers stateless requests (server/discover first) over the new transport.',
      verify: 'server/discover returns 200 with the capability document over Streamable HTTP.',
    },
  ],
  'initialize-handshake': [
    {
      step: 1,
      action: 'Stop calling initialize: stamp protocol version + capabilities in _meta on every request instead.',
      verify: 'No initialize call is issued; every request carries _meta.protocolVersion.',
    },
    {
      step: 2,
      action: 'Call server/discover first to learn capabilities and extensions.',
      verify: 'discover() returns the capability document before the first tool call.',
    },
    {
      step: 3,
      action: 'Remove the session-id state from the client (no stored session).',
      verify: 'The client holds no session id; two identical requests give identical results.',
    },
  ],
  'mcp-session-id-header': [
    {
      step: 1,
      action: 'Stop sending the Mcp-Session-Id header on every request.',
      verify: 'Outgoing requests carry no Mcp-Session-Id header.',
    },
    {
      step: 2,
      action: 'Route by request content (tenant + capabilities in _meta) instead of by session.',
      verify: 'Requests reach any instance; no sticky routing by session id remains.',
    },
  ],
};

/**
 * Build the migration plan for one deprecated feature.
 * Returns undefined for a feature that is not deprecated.
 */
export function mcpV8MigrationPlan(
  feature: string,
  nowMs: number = Date.now(),
): McpV8MigrationPlan | undefined {
  const entry = mcpV8DeprecationByFeature(feature);
  if (entry === undefined) return undefined;
  const steps = MCP_V8_MIGRATION_STEPS[feature] ?? [
    {
      step: 1,
      action: `Stop using ${feature}: ${entry.replacement}`,
      verify: `No call uses ${feature} anymore.`,
    },
  ];
  return {
    feature: entry.feature,
    deprecatedOn: entry.deprecatedOn,
    earliestRemoval: entry.earliestRemoval,
    replacement: entry.replacement,
    steps: steps.map((s) => ({ ...s })),
    pastRemovalFloor: nowMs >= Date.parse(`${entry.earliestRemoval}T00:00:00Z`),
  };
}

/** Migration plans for every deprecated feature. */
export function mcpV8AllMigrationPlans(nowMs: number = Date.now()): McpV8MigrationPlan[] {
  return MCP_V8_DEPRECATIONS.map((d) => mcpV8MigrationPlan(d.feature, nowMs) as McpV8MigrationPlan);
}

/** Removal-floor status for the whole deprecated surface. */
export interface McpV8RemovalStatus {
  /** Removal floor date. */
  removalFloor: string;
  /** Days from nowMs until the floor (negative when past). */
  daysUntilRemoval: number;
  /** True when nowMs is past the floor (deprecated features may be removed). */
  pastFloor: boolean;
  /** Deprecated features still in use (by the tracker's counts). */
  featuresInUse: string[];
}

/** Tracker options. */
export interface McpV8DeprecationTrackerOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Max warnings kept (default 512; oldest dropped first). */
  maxWarnings?: number;
}

/**
 * Deprecation tracker: records every use of a deprecated
 * feature, emits a structured warning per use, and reports
 * counts. The tracker never blocks a call — deprecated
 * features still run until the removal floor — but every use
 * is visible, so nothing deprecated is used silently.
 */
export class McpV8DeprecationTracker {
  private warnings: McpV8DeprecationWarning[] = [];
  private counts = new Map<string, number>();
  private nowMs: () => number;
  private maxWarnings: number;

  constructor(options: McpV8DeprecationTrackerOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.maxWarnings = options.maxWarnings ?? 512;
  }

  /**
   * Record one use of a feature. Returns the warning when
   * the feature is deprecated, or undefined when it is not
   * (non-deprecated uses are not recorded).
   */
  record(feature: string, caller: string): McpV8DeprecationWarning | undefined {
    const entry = mcpV8DeprecationByFeature(feature);
    if (entry === undefined) return undefined;
    const atMs = this.nowMs();
    const warning: McpV8DeprecationWarning = {
      feature,
      caller,
      atMs,
      replacement: entry.replacement,
      earliestRemoval: entry.earliestRemoval,
      message: `Deprecated feature "${feature}" used by "${caller}": ${entry.replacement} (earliest removal ${entry.earliestRemoval}).`,
    };
    this.warnings.push(warning);
    while (this.warnings.length > this.maxWarnings) this.warnings.shift();
    this.counts.set(feature, (this.counts.get(feature) ?? 0) + 1);
    return warning;
  }

  /** Total deprecated uses recorded. */
  totalUses(): number {
    return this.warnings.length;
  }

  /** Uses per feature (only features actually used). */
  countsByFeature(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [feature, count] of [...this.counts.entries()].sort()) out[feature] = count;
    return out;
  }

  /** All warnings (oldest first). */
  allWarnings(): McpV8DeprecationWarning[] {
    return this.warnings.map((w) => ({ ...w }));
  }

  /** Warnings for one feature (oldest first). */
  warningsFor(feature: string): McpV8DeprecationWarning[] {
    return this.warnings.filter((w) => w.feature === feature).map((w) => ({ ...w }));
  }

  /** Features used at least once. */
  featuresUsed(): string[] {
    return [...this.counts.keys()].sort();
  }

  /** True when any deprecated feature was used. */
  anyUsed(): boolean {
    return this.warnings.length > 0;
  }

  /** Clear all recorded warnings and counts. */
  clear(): void {
    this.warnings = [];
    this.counts.clear();
  }

  /** Removal-floor status, given the features this tracker saw. */
  removalStatus(nowMs?: number): McpV8RemovalStatus {
    const now = nowMs ?? this.nowMs();
    const floorMs = Date.parse(`${MCP_V8_LEGACY_REMOVAL_DATE}T00:00:00Z`);
    const daysUntilRemoval = Math.floor((floorMs - now) / (24 * 60 * 60 * 1000));
    return {
      removalFloor: MCP_V8_LEGACY_REMOVAL_DATE,
      daysUntilRemoval,
      pastFloor: now >= floorMs,
      featuresInUse: this.featuresUsed(),
    };
  }
}

/** Transport policy: which transport to use, and what to warn about. */
export interface McpV8TransportPolicy {
  /** Preferred transport. */
  preferred: 'streamable-http';
  /** Deprecated transport (warn on every use). */
  deprecated: 'http-sse';
  /** Transports the host may still use (stdio is local, not HTTP). */
  allowed: readonly string[];
}

/** The v8 transport policy (Streamable HTTP first). */
export function defaultMcpV8TransportPolicy(): McpV8TransportPolicy {
  return {
    preferred: 'streamable-http',
    deprecated: 'http-sse',
    allowed: ['streamable-http', 'stdio', 'http-sse'],
  };
}

/** Result of checking a transport choice against the policy. */
export interface McpV8TransportCheck {
  transport: string;
  /** True when the transport may be used. */
  allowed: boolean;
  /** True when the transport is the preferred one. */
  preferred: boolean;
  /** Warning when the transport is deprecated (undefined when clean). */
  warning?: string;
  /** What to use instead (when deprecated). */
  replacement?: string;
}

/** Check one transport choice against the v8 policy. */
export function checkMcpV8Transport(
  transport: string,
  policy: McpV8TransportPolicy = defaultMcpV8TransportPolicy(),
): McpV8TransportCheck {
  if (!policy.allowed.includes(transport)) {
    return {
      transport,
      allowed: false,
      preferred: false,
      warning: `Transport "${transport}" is not allowed (allowed: ${policy.allowed.join(', ')}).`,
    };
  }
  if (transport === policy.deprecated) {
    const entry = mcpV8DeprecationByFeature('http-sse-transport');
    return {
      transport,
      allowed: true,
      preferred: false,
      warning: `Transport "http-sse" is deprecated (earliest removal ${entry?.earliestRemoval ?? MCP_V8_LEGACY_REMOVAL_DATE}). Use Streamable HTTP.`,
      replacement: 'streamable-http',
    };
  }
  return { transport, allowed: true, preferred: transport === policy.preferred };
}

/** One row of the deprecation report (for the UI). */
export interface McpV8DeprecationReportRow {
  feature: string;
  deprecatedOn: string;
  earliestRemoval: string;
  replacement: string;
  uses: number;
  migrationSteps: number;
}

/** Build the deprecation report from a tracker (or empty counts). */
export function buildMcpV8DeprecationReport(
  tracker?: McpV8DeprecationTracker,
): McpV8DeprecationReportRow[] {
  const counts = tracker?.countsByFeature() ?? {};
  return MCP_V8_DEPRECATIONS.map((entry: McpV8DeprecationEntry) => ({
    feature: entry.feature,
    deprecatedOn: entry.deprecatedOn,
    earliestRemoval: entry.earliestRemoval,
    replacement: entry.replacement,
    uses: counts[entry.feature] ?? 0,
    migrationSteps: (MCP_V8_MIGRATION_STEPS[entry.feature] ?? []).length,
  }));
}

/** Re-export for callers that only import this module. */
export { mcpV8IsDeprecated };
