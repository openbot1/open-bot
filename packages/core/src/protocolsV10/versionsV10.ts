/**
 * Protocols v10 — version matrix + feature flags (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): MCP spec 2026-07-28 is
 * now the settled core — stateless HTTP, `server/discover`,
 * progressive tool discovery (`defer_loading`), the Tasks
 * extension, MCP Apps, and stricter OAuth (issuer validation
 * per RFC 9207, token bound to its issuing server, Dynamic
 * Client Registration deprecated). A2A v1.0 is the agent-agent
 * handshake track that complements MCP's agent-to-tool track;
 * both live under the Agentic AI Foundation since 08/2026.
 * The spec also fixes a deprecation policy: a deprecated
 * feature stays at least 12 months before removal (90 days
 * only for an actively exploited security flaw).
 *
 * What v10 adds over v9 (all open-bot layers, written from
 * those descriptions — no code, text or asset from any other
 * repo is copied here):
 *  - MCP stateless v10: OTel trace in `_meta`, deterministic
 *    tool listing (sorted, cache-friendly), one opt-in change
 *    stream (`subscriptions/listen`), server-issued state
 *    handles the client passes back as a plain tool argument.
 *  - OAuth v10: token issuer validation (RFC 9207), token
 *    binding to the issuing server, DCR deprecated in favour
 *    of explicit registration / Client ID Metadata Documents.
 *  - Tool search: `defer_loading` markers + a search index so
 *    the agent searches tools on demand instead of loading
 *    the whole registry (>1.100 tools).
 *  - Tasks extension v10: priorities, dependencies, retry
 *    policy, progress events, durable snapshots.
 *  - MCP Apps v10: the postMessage bridge — UI calls the MCP
 *    server through the host over JSON-RPC 2.0 (`ui/initialize`,
 *    `tools/call`), the host arbitrates every call, CSP is
 *    built from declared domains only.
 *  - Multi round-trip v10: `input_required` rounds with
 *    schema-checked answers, replacing server-initiated
 *    sampling / elicitation callbacks.
 *  - A2A v10: a minimal v1.0 handshake (Agent Card +
 *    capability intersection) next to the v9 1.1 delegation.
 *  - Deprecation policy registry: 12-month floor, 90-day
 *    security floor, removal guard.
 *
 * Version rules (v10):
 * - mcp: `2026-07-28` current (unchanged from v8/v9).
 * - a2a: `1.1` is the implemented delegation track (v9);
 *   `1.0` is the minimal-handshake track added here.
 * - acp: `draft` (unchanged). ucp: `2026-08-25` read-only.
 * - gov: `1.0`. nanda: `0.1-local`. agui / a2ui: `1.0`.
 * - poppy: `1.0` watch-only.
 */

export const PROTOCOL_V10_FAMILIES = [
  'a2a',
  'mcp',
  'ucp',
  'acp',
  'gov',
  'agui',
  'a2ui',
  'poppy',
  'nanda',
] as const;
export type ProtocolV10Family = (typeof PROTOCOL_V10_FAMILIES)[number];

/** A2A versions open-bot speaks; v10 adds the 1.0 minimal-handshake track. */
export const A2A_V10_VERSIONS = ['1.1', '1.0', '1.0.1', '0.3', '0.2'] as const;
export const A2A_V10_CURRENT_VERSION = '1.1';
export const A2A_V10_IMPLEMENTED_VERSION = '1.1';
/** The minimal-handshake track (new in v10, loopback-only). */
export const A2A_V10_HANDSHAKE_VERSION = '1.0';
export const A2A_V10_PREVIOUS_VERSION = '1.0.1';
export const A2A_V10_LEGACY_VERSIONS = ['1.0.1', '1.0'] as const;
export const A2A_V10_REMOVED_VERSIONS = ['0.3', '0.2'] as const;

/** MCP core version (spec 2026-07-28) — unchanged from v8/v9. */
export const MCP_V10_CURRENT_VERSION = '2026-07-28';
export const MCP_V10_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V10_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build (from v8). */
export const MCP_V10_LEGACY_REMOVAL_DATE = '2027-07-28';
export const MCP_V10_STATELESS = true as const;
/** `server/discover` is mandatory for v10 servers. */
export const MCP_V10_DISCOVER_METHOD = 'server/discover' as const;
/** The single opt-in change-notification stream. */
export const MCP_V10_SUBSCRIPTIONS_METHOD = 'subscriptions/listen' as const;
/** Session-only methods stay refused (no handshake, no session id). */
export const MCP_V10_SESSION_ONLY_METHODS = ['initialize', 'notifications/initialized'] as const;

/** ACP (Agent Client Protocol, Zed) track — draft, unchanged. */
export const ACP_V10_VERSIONS = ['draft'] as const;
export const ACP_V10_CURRENT_VERSION = 'draft';
export const ACP_V10_IMPLEMENTATION_VERSION = '10.0';
/** The IBM/BeeAI ACP merged into A2A — never negotiated. */
export const ACP_V10_MERGED_TRACK = 'merged' as const;
/** CLI agents the ACP session layer knows how to map. */
export const ACP_V10_KNOWN_AGENTS = ['claude', 'codex', 'gemini'] as const;
export type AcpV10KnownAgent = (typeof ACP_V10_KNOWN_AGENTS)[number];
/** ACP session permission modes (client-side policy). */
export const ACP_V10_PERMISSION_MODES = ['ask', 'auto', 'read-only'] as const;
export type AcpV10PermissionMode = (typeof ACP_V10_PERMISSION_MODES)[number];

/** UCP stays read-only (unchanged from v7/v8/v9). */
export const UCP_V10_CURRENT_VERSION = '2026-08-25';
export const UCP_V10_MODE = 'read-only' as const;
/** Governance layer version (unchanged). */
export const GOV_V10_CURRENT_VERSION = '1.0';
/** NANDA local sketch version (unchanged). */
export const NANDA_V10_CURRENT_VERSION = '0.1-local';
/** AG-UI / A2UI current versions (unchanged). */
export const AGUI_V10_CURRENT_VERSION = '1.0';
export const A2UI_V10_CURRENT_VERSION = '1.0';
/** Poppy is watch-only (unchanged). */
export const POPPY_V10_CURRENT_VERSION = '1.0';
export const POPPY_V10_STATUS = 'watch-only' as const;

/**
 * Deprecation policy (spec 2026-07-28): a deprecated feature
 * must stay for at least 12 months; only an actively
 * exploited security flaw shortens that to 90 days.
 */
export const MCP_V10_DEPRECATION_MONTHS = 12;
export const MCP_V10_DEPRECATION_SECURITY_DAYS = 90;
export const MCP_V10_DEPRECATION_EARLIEST_REMOVAL = '2027-07-28';

/** Current version per family (the v10 matrix). */
export const PROTOCOL_V10_CURRENT_VERSIONS: Record<ProtocolV10Family, string> = {
  a2a: A2A_V10_CURRENT_VERSION,
  mcp: MCP_V10_CURRENT_VERSION,
  ucp: UCP_V10_CURRENT_VERSION,
  acp: ACP_V10_CURRENT_VERSION,
  gov: GOV_V10_CURRENT_VERSION,
  agui: AGUI_V10_CURRENT_VERSION,
  a2ui: A2UI_V10_CURRENT_VERSION,
  poppy: POPPY_V10_CURRENT_VERSION,
  nanda: NANDA_V10_CURRENT_VERSION,
};

/** All versions open-bot accepts per family (newest first). */
export const PROTOCOL_V10_VERSION_MATRIX: Record<ProtocolV10Family, readonly string[]> = {
  a2a: A2A_V10_VERSIONS,
  mcp: MCP_V10_VERSIONS,
  ucp: [UCP_V10_CURRENT_VERSION],
  acp: ACP_V10_VERSIONS,
  gov: [GOV_V10_CURRENT_VERSION],
  agui: [AGUI_V10_CURRENT_VERSION],
  a2ui: [A2UI_V10_CURRENT_VERSION],
  poppy: [POPPY_V10_CURRENT_VERSION],
  nanda: [NANDA_V10_CURRENT_VERSION],
};

/** One-line summary of the v10 matrix, for the UI / logs. */
export function protocolV10MatrixSummary(): string {
  return PROTOCOL_V10_FAMILIES.map(
    (family) => `${family} ${PROTOCOL_V10_CURRENT_VERSIONS[family]}`,
  ).join(', ');
}

/** Result of negotiating one family with a peer. */
export interface ProtocolV10Negotiation {
  family: ProtocolV10Family;
  /** Highest version both sides speak (undefined when none). */
  agreed: string | undefined;
  /** Whether the peer offers the current version. */
  peerHasCurrent: boolean;
  /** Versions the peer offers that open-bot does not speak. */
  peerOnly: string[];
  /** Versions open-bot speaks that the peer does not offer. */
  localOnly: string[];
}

/**
 * Negotiate one family: the agreed version is the newest
 * version (in open-bot's preference order) that the peer
 * also offers. Unknown peer versions never win.
 */
export function negotiateProtocolV10Version(
  family: ProtocolV10Family,
  serverVersions: readonly string[],
): ProtocolV10Negotiation {
  const local = PROTOCOL_V10_VERSION_MATRIX[family] ?? [];
  const peer = [...new Set(serverVersions.filter((v) => typeof v === 'string'))];
  const agreed = local.find((v) => peer.includes(v));
  return {
    family,
    agreed,
    peerHasCurrent: peer.includes(PROTOCOL_V10_CURRENT_VERSIONS[family]),
    peerOnly: peer.filter((v) => !local.includes(v)),
    localOnly: local.filter((v) => !peer.includes(v)),
  };
}

/** Negotiate every family at once (missing families = no peer offer). */
export function negotiateAllProtocolsV10(
  offered: Partial<Record<ProtocolV10Family, readonly string[]>>,
): Record<ProtocolV10Family, ProtocolV10Negotiation> {
  const out = {} as Record<ProtocolV10Family, ProtocolV10Negotiation>;
  for (const family of PROTOCOL_V10_FAMILIES) {
    out[family] = negotiateProtocolV10Version(family, offered[family] ?? []);
  }
  return out;
}

/** What changed from protocols v9 to v10 (for the UI / changelog). */
export function protocolV10ChangesSinceV9(): string[] {
  return [
    'mcp: stateless v10 — OpenTelemetry trace in _meta, deterministic tool listing (sorted, cache-friendly), one opt-in change stream (subscriptions/listen), server-issued state handles passed back as plain tool arguments.',
    'mcp: OAuth v10 — token issuer validation (RFC 9207), tokens bound to the issuing server; Dynamic Client Registration is deprecated in favour of explicit registration / Client ID Metadata Documents.',
    'mcp: tool search — defer_loading markers + a search index so the agent searches tools on demand instead of loading the whole registry.',
    'mcp: Tasks extension v10 — priorities, dependencies, retry policy, progress events, durable snapshots.',
    'mcp: Apps v10 — postMessage bridge (ui/initialize + tools/call over JSON-RPC 2.0), host arbitrates every UI-to-tool call, CSP built from declared domains only.',
    'mcp: multi round-trip v10 — input_required rounds with schema-checked answers replace server-initiated sampling / elicitation callbacks.',
    'a2a: minimal 1.0 handshake track (Agent Card + capability intersection, loopback-only) next to the 1.1 delegation track.',
    'policy: deprecation registry — 12-month removal floor, 90-day floor only for an actively exploited security flaw.',
    'mcp / ucp / acp / gov / agui / a2ui / poppy / nanda: versions unchanged from v9.',
  ];
}

/** What a v10 peer loses when it downgrades to v9. */
export function protocolV10DowngradeToV9(): Record<string, string> {
  return {
    a2a: '1.0 minimal handshake is unavailable; v9 1.1 delegation still works.',
    mcp: 'Stateless v10 (_meta trace, deterministic listing, subscriptions/listen, state handles), OAuth issuer validation + token binding, tool search, Tasks v10 (priorities/dependencies/retries), Apps v10 postMessage bridge, multi round-trip v10 and the deprecation registry are unavailable; v9 stateless + Apps v2 + Tasks v8 still work.',
    acp: 'unchanged (draft).',
    ucp: 'unchanged (2026-08-25 read-only).',
    gov: 'unchanged (1.0).',
    agui: 'unchanged (1.0).',
    a2ui: 'unchanged (1.0).',
    poppy: 'unchanged (1.0, watch-only).',
    nanda: 'unchanged (0.1-local).',
  };
}

/** Feature flags for the v10 additions (all on by default, local-only). */
export interface ProtocolV10FeatureFlags {
  /** MCP stateless v10 (trace, deterministic listing, subscriptions). */
  mcpStatelessV10: boolean;
  /** OAuth v10 issuer validation + token binding. */
  oauthV10: boolean;
  /** Tool search (defer_loading + index). */
  toolSearch: boolean;
  /** Tasks extension v10. */
  mcpTasksV10: boolean;
  /** MCP Apps v10 postMessage bridge. */
  mcpAppsV10: boolean;
  /** Multi round-trip v10 (input_required). */
  multiRoundTripV10: boolean;
  /** A2A v10 minimal 1.0 handshake. */
  a2aHandshakeV10: boolean;
  /** Loopback guard (must stay on: A2A is local-only). */
  loopbackOnly: boolean;
}

export const PROTOCOL_V10_DEFAULT_FEATURES: ProtocolV10FeatureFlags = {
  mcpStatelessV10: true,
  oauthV10: true,
  toolSearch: true,
  mcpTasksV10: true,
  mcpAppsV10: true,
  multiRoundTripV10: true,
  a2aHandshakeV10: true,
  loopbackOnly: true,
};

/**
 * Validate feature flags: the loopback guard may never be
 * switched off — A2A in open-bot is local/loopback only.
 * Returns problems (empty when valid).
 */
export function validateProtocolV10Features(flags: ProtocolV10FeatureFlags): string[] {
  const problems: string[] = [];
  if (flags.loopbackOnly !== true) {
    problems.push('loopbackOnly must stay true: A2A delegation is local/loopback only and must never reach the public internet.');
  }
  return problems;
}

/** A2A v10 task states (same machine as v7/v8/v9: terminal states never move). */
export const A2A_V10_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;
export type A2aV10TaskState = (typeof A2A_V10_TASK_STATES)[number];
export const A2A_V10_TERMINAL_TASK_STATES: readonly A2aV10TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];
export function isA2aV10TaskTerminal(state: A2aV10TaskState): boolean {
  return (A2A_V10_TERMINAL_TASK_STATES as readonly A2aV10TaskState[]).includes(state);
}

/** Legal transitions of the A2A v10 task state machine. */
export const A2A_V10_TASK_TRANSITIONS: Record<A2aV10TaskState, readonly A2aV10TaskState[]> = {
  submitted: ['working', 'input-required', 'canceled', 'rejected', 'failed'],
  working: ['working', 'input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'canceled', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export function isA2aV10TaskTransitionLegal(from: A2aV10TaskState, to: A2aV10TaskState): boolean {
  return (A2A_V10_TASK_TRANSITIONS[from] as readonly A2aV10TaskState[]).includes(to);
}

/** MCP Apps v10 app-instance states (same set as v9). */
export const MCP_V10_APP_STATES = [
  'opening',
  'active',
  'suspended',
  'closed',
  'failed',
] as const;
export type McpV10AppState = (typeof MCP_V10_APP_STATES)[number];

/** ACP session states (v10 keeps the v9 set). */
export const ACP_V10_SESSION_STATUSES = [
  'active',
  'idle',
  'suspended',
  'cancelled',
  'completed',
  'failed',
] as const;
export type AcpV10SessionStatus = (typeof ACP_V10_SESSION_STATUSES)[number];
export const ACP_V10_SESSION_TERMINAL: readonly AcpV10SessionStatus[] = [
  'cancelled',
  'completed',
  'failed',
];
export function isAcpV10SessionTerminal(status: AcpV10SessionStatus): boolean {
  return (ACP_V10_SESSION_TERMINAL as readonly AcpV10SessionStatus[]).includes(status);
}
