/**
 * Protocols v11 — MCP 2.0 version matrix + interop matrix (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): spec 2026-07-28 is the
 * settled stateless core — no `initialize` handshake, no
 * `Mcp-Session-Id`; every request carries its protocol version
 * and capabilities in `_meta`; `server/discover` is the entry
 * point; routing headers steer a request to the right server;
 * lists are cacheable. Mid-request callbacks are gone:
 * sampling / elicitation / roots are replaced by Multi
 * Round-Trip Requests (the server answers `input_required`
 * and the client calls again with the input). Tasks is a
 * formal extension (`io.modelcontextprotocol/tasks`) and MCP
 * Apps is a formal UI extension (`io.modelcontextprotocol/ui`).
 * OAuth issuer (`iss`) validation is mandatory. Roots /
 * Sampling / Logging are deprecated with a 12-month offramp
 * (no removal before 2027-07-28). A 2026-07-28 client falls
 * back to the `initialize` handshake when it meets a server
 * at 2025-11-25 or older.
 *
 * What v11 adds over v10 (all open-bot layers, written from
 * that description — no code, text or asset from any other
 * repo is copied here):
 *  - A full interop matrix: every (client version, server
 *    version) pair maps to `stateless`, `handshake-fallback`
 *    or `unsupported`, with the capability downgrade spelled
 *    out per pair (no MRTR / no Tasks extension / no Apps
 *    extension on legacy servers).
 *  - Version negotiation that prefers 2026-07-28 and falls
 *    back deterministically, never silently.
 *  - A deprecation table for the three deprecated features
 *    (roots, sampling, logging) with the 12-month floor and
 *    the 90-day security floor, plus a removal guard.
 *  - The extension namespace registry (`tasks`, `ui`) and
 *    the feature-flag set the `_meta` capabilities advertise.
 *
 * No network is opened by this module. No dependency on the
 * deprecated Roots / Sampling / Logging features is added
 * anywhere in v11: they appear here only as deprecation
 * records so callers can detect and refuse them.
 */

/** MCP core version (spec 2026-07-28) — current for v11. */
export const MCP_V11_CURRENT_VERSION = '2026-07-28';
/** Every MCP protocol version v11 knows, newest first. */
export const MCP_V11_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export type McpV11Version = (typeof MCP_V11_VERSIONS)[number];
/** Versions that need the `initialize` handshake (at or below the cutoff). */
export const MCP_V11_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Newest server version that still requires a handshake. */
export const MCP_V11_HANDSHAKE_CUTOFF_VERSION = '2025-11-25';
/** A version string v11 does not recognise at all. */
export const MCP_V11_UNKNOWN_VERSION = 'unknown';

/** Tasks extension namespace (formal extension in MCP 2.0). */
export const MCP_V11_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks' as const;
/** MCP Apps UI extension namespace (formal extension in MCP 2.0). */
export const MCP_V11_UI_EXTENSION = 'io.modelcontextprotocol/ui' as const;
/** Extension namespaces v11 negotiates. */
export const MCP_V11_EXTENSIONS = [MCP_V11_TASKS_EXTENSION, MCP_V11_UI_EXTENSION] as const;
export type McpV11Extension = (typeof MCP_V11_EXTENSIONS)[number];

/** `server/discover` — mandatory entry point for v11 servers. */
export const MCP_V11_DISCOVER_METHOD = 'server/discover' as const;
/** Session-only methods stay refused on a v11 server. */
export const MCP_V11_SESSION_ONLY_METHODS = ['initialize', 'notifications/initialized'] as const;
/** The `Mcp-Session-Id` header is refused on the stateless transport. */
export const MCP_V11_SESSION_ID_HEADER = 'mcp-session-id' as const;

/** Deprecation floor: 12 months before a deprecated feature may be removed. */
export const MCP_V11_DEPRECATION_MONTHS = 12;
/** Security floor: 90 days when an actively exploited flaw is involved. */
export const MCP_V11_DEPRECATION_SECURITY_DAYS = 90;
/** Earliest removal date for anything deprecated on 2026-07-28. */
export const MCP_V11_DEPRECATION_EARLIEST_REMOVAL = '2027-07-28';

/** Capability flags a v11 client advertises in `_meta.capabilities`. */
export const MCP_V11_CAPABILITY_KEYS = [
  'multiRoundTrip',
  'tasks',
  'apps',
  'cacheableLists',
  'routing',
] as const;
export type McpV11CapabilityKey = (typeof MCP_V11_CAPABILITY_KEYS)[number];

/** Full capabilities object carried in `_meta`. */
export interface McpV11Capabilities {
  multiRoundTrip: boolean;
  tasks: boolean;
  apps: boolean;
  cacheableLists: boolean;
  routing: boolean;
}

/** Default capabilities: a v11 client offers everything. */
export const MCP_V11_DEFAULT_CAPABILITIES: McpV11Capabilities = {
  multiRoundTrip: true,
  tasks: true,
  apps: true,
  cacheableLists: true,
  routing: true,
};

/** Capabilities a legacy (handshake) server can actually honour. */
export const MCP_V11_LEGACY_CAPABILITIES: McpV11Capabilities = {
  multiRoundTrip: false,
  tasks: false,
  apps: false,
  cacheableLists: false,
  routing: false,
};

/** One deprecated feature, recorded so callers can detect and refuse it. */
export interface McpV11DeprecationEntry {
  /** Feature id: `roots`, `sampling` or `logging`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Spec date it was deprecated (2026-07-28 for all three). */
  deprecatedSince: string;
  /** Earliest date it may be removed (12-month floor). */
  earliestRemoval: string;
  /** What replaces it (MRTR for sampling/elicitation, nothing for roots/logging). */
  replacedBy: string;
  /** Why it went away. */
  reason: string;
}

/** The three features MCP 2.0 deprecates. */
export function defaultMcpV11Deprecations(): McpV11DeprecationEntry[] {
  return [
    {
      id: 'roots',
      name: 'Roots',
      deprecatedSince: '2026-07-28',
      earliestRemoval: MCP_V11_DEPRECATION_EARLIEST_REMOVAL,
      replacedBy: 'explicit tool arguments + server/discover',
      reason: 'Roots let the server pull client-side filesystem context mid-request; MCP 2.0 removes mid-request callbacks entirely.',
    },
    {
      id: 'sampling',
      name: 'Sampling',
      deprecatedSince: '2026-07-28',
      earliestRemoval: MCP_V11_DEPRECATION_EARLIEST_REMOVAL,
      replacedBy: 'multi round-trip requests (input_required)',
      reason: 'Sampling let the server call back into the client model mid-request; MCP 2.0 replaces it with server-declared input_required rounds.',
    },
    {
      id: 'logging',
      name: 'Logging',
      deprecatedSince: '2026-07-28',
      earliestRemoval: MCP_V11_DEPRECATION_EARLIEST_REMOVAL,
      replacedBy: 'host-side telemetry (OpenTelemetry trace in _meta)',
      reason: 'Server-pushed log notifications are part of the removed mid-request callback surface; hosts observe via trace ids instead.',
    },
  ];
}

/** How a v11 client talks to a given server version. */
export type McpV11InteropMode = 'stateless' | 'handshake-fallback' | 'unsupported';

/** One row of the interop matrix. */
export interface McpV11InteropRow {
  clientVersion: string;
  serverVersion: string;
  mode: McpV11InteropMode;
  /** Whether the client must run `initialize` first. */
  handshakeRequired: boolean;
  /** Capabilities the pair can actually use. */
  capabilities: McpV11Capabilities;
  /** Human-readable warnings (empty when the pair is clean). */
  warnings: string[];
}

/** Order index of a version (lower = newer). Unknown versions sort last. */
export function mcpV11VersionRank(version: string): number {
  const idx = (MCP_V11_VERSIONS as readonly string[]).indexOf(version);
  return idx === -1 ? MCP_V11_VERSIONS.length : idx;
}

/** True when `version` is a version v11 knows. */
export function isMcpV11KnownVersion(version: string): boolean {
  return (MCP_V11_VERSIONS as readonly string[]).includes(version);
}

/** True when a server at `version` needs the handshake fallback. */
export function mcpV11NeedsHandshake(version: string): boolean {
  if (!isMcpV11KnownVersion(version)) return false;
  return mcpV11VersionRank(version) >= mcpV11VersionRank(MCP_V11_HANDSHAKE_CUTOFF_VERSION);
}

/**
 * Negotiate one MCP version from the peer's offered list: the
 * newest version both sides know, preferring 2026-07-28.
 * Returns undefined when there is no overlap at all.
 */
export function negotiateMcpV11Version(offered: readonly string[]): string | undefined {
  for (const version of MCP_V11_VERSIONS) {
    if (offered.includes(version)) return version;
  }
  return undefined;
}

/** Downgrade the capability set for a legacy server version. */
export function mcpV11CapabilitiesForServer(serverVersion: string): McpV11Capabilities {
  if (!isMcpV11KnownVersion(serverVersion)) return { ...MCP_V11_LEGACY_CAPABILITIES };
  if (mcpV11NeedsHandshake(serverVersion)) return { ...MCP_V11_LEGACY_CAPABILITIES };
  return { ...MCP_V11_DEFAULT_CAPABILITIES };
}

/**
 * Decide how a v11 client talks to a server at `serverVersion`.
 * - server 2026-07-28: stateless, full capabilities.
 * - server 2025-11-25 or older: handshake fallback, no v11 capabilities.
 * - unknown server version: unsupported (refuse rather than guess).
 */
export function mcpV11InteropMode(
  clientVersion: string,
  serverVersion: string,
): McpV11InteropRow {
  const warnings: string[] = [];
  if (!isMcpV11KnownVersion(clientVersion)) {
    return {
      clientVersion,
      serverVersion,
      mode: 'unsupported',
      handshakeRequired: false,
      capabilities: { ...MCP_V11_LEGACY_CAPABILITIES },
      warnings: [`Unknown client version "${clientVersion}".`],
    };
  }
  if (!isMcpV11KnownVersion(serverVersion)) {
    return {
      clientVersion,
      serverVersion,
      mode: 'unsupported',
      handshakeRequired: false,
      capabilities: { ...MCP_V11_LEGACY_CAPABILITIES },
      warnings: [`Unknown server version "${serverVersion}": refusing rather than guessing.`],
    };
  }
  if (mcpV11NeedsHandshake(serverVersion)) {
    warnings.push(
      `Server ${serverVersion} predates stateless MCP: falling back to the initialize handshake. ` +
        `Multi round-trip, Tasks and Apps extensions are unavailable on this server.`,
    );
    return {
      clientVersion,
      serverVersion,
      mode: 'handshake-fallback',
      handshakeRequired: true,
      capabilities: { ...MCP_V11_LEGACY_CAPABILITIES },
      warnings,
    };
  }
  return {
    clientVersion,
    serverVersion,
    mode: 'stateless',
    handshakeRequired: false,
    capabilities: { ...MCP_V11_DEFAULT_CAPABILITIES },
    warnings,
  };
}

/** The full interop matrix: current client against every known server version. */
export function mcpV11InteropMatrix(): McpV11InteropRow[] {
  return MCP_V11_VERSIONS.map((serverVersion) =>
    mcpV11InteropMode(MCP_V11_CURRENT_VERSION, serverVersion),
  );
}

/** One-line summary of the matrix, for logs and the registry tool. */
export function mcpV11InteropSummary(): string {
  return mcpV11InteropMatrix()
    .map((row) => `${row.serverVersion} -> ${row.mode}`)
    .join(', ');
}

/** What changed between protocols v10 and v11 (for the versions tool). */
export function protocolV11ChangesSinceV10(): string[] {
  return [
    'stateless core 2026-07-28 completed: every request carries protocol version + capabilities in _meta; initialize and Mcp-Session-Id are refused, not merely discouraged',
    'server/discover is the only entry point; discover returns the extension list (tasks, ui) and the routing table',
    'routing headers: mcp-routing-key / mcp-target-server / mcp-request-id steer a request to the right server behind one endpoint',
    'cacheable lists: tools/list, resources/list and prompts/list carry a listHash + listVersion; a client that already holds the hash gets a not-modified answer instead of the full list',
    'multi round-trip requests (SEP-2322): input_required rounds with schema-checked answers, at least 2 rounds, journaled; sampling/elicitation callbacks are gone',
    'Tasks is a formal extension (io.modelcontextprotocol/tasks): tasks/create, tasks/get polling, tasks/list, tasks/cancel, progress events',
    'MCP Apps is a formal UI extension (io.modelcontextprotocol/ui): HTML in a sandboxed iframe, CSP built from declared domains only, host arbitrates every UI tool call',
    'OAuth iss validation is mandatory: token iss must exactly match the expected issuer (RFC 9207); mismatch is a hard reject, not a warning',
    'interop matrix: new client vs old server (2025-11-25 and older) falls back to the initialize handshake with all v11 capabilities downgraded off',
    'roots / sampling / logging are deprecated (2026-07-28, earliest removal 2027-07-28); v11 adds no dependency on any of them',
  ];
}

/** Describe the v10 surface a v11 client gives up when it downgrades. */
export function protocolV11DowngradeToV10(): { mcp: string; lost: string[] } {
  return {
    mcp: 'Downgrade from MCP 2.0 (v11) to the v10 stateless layer: routing headers and cacheable lists are dropped, the Tasks/UI extensions fall back to their v10 shapes, and OAuth iss validation keeps running (it is mandatory in both).',
    lost: ['routing headers', 'cacheable lists (listHash/listVersion)', 'formal Tasks extension namespace', 'formal UI extension namespace', 'interop matrix handshake fallback'],
  };
}

/** Earliest removal date for a feature deprecated on `since` (12-month floor, 90-day security floor). */
export function mcpV11EarliestRemovalDate(deprecatedSince: string, securityFlaw = false): string {
  const since = new Date(`${deprecatedSince}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) return MCP_V11_DEPRECATION_EARLIEST_REMOVAL;
  if (securityFlaw) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + MCP_V11_DEPRECATION_SECURITY_DAYS);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(since);
  d.setUTCMonth(d.getUTCMonth() + MCP_V11_DEPRECATION_MONTHS);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (negative when `to` is before `from`). */
export function mcpV11DaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** Today's date as ISO `YYYY-MM-DD` (UTC). */
export function mcpV11TodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Validate a feature-flag object: every flag must be a boolean, no unknown flags. */
export function validateMcpV11Features(features: unknown): string[] {
  const problems: string[] = [];
  if (typeof features !== 'object' || features === null || Array.isArray(features)) {
    return ['features must be an object.'];
  }
  const record = features as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(MCP_V11_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      problems.push(`Unknown capability flag "${key}".`);
    } else if (typeof record[key] !== 'boolean') {
      problems.push(`Capability flag "${key}" must be a boolean.`);
    }
  }
  return problems;
}
