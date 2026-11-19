/**
 * Protocols v9 — version matrix + MCP Apps v2 / ACP sessions / A2A
 * delegation feature flags (v1.40, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v140.md (section 5): MCP, A2A and ACP are
 * three complementary layers — MCP is agent-to-tool/data, A2A
 * is agent-to-agent (Agent Card at a well-known URL, task
 * delegation, message + artifact exchange, task lifecycle),
 * and ACP here is the Agent Client Protocol (Zed, client/editor
 * <-> coding agent), which is how a client runs Claude Code /
 * Codex / Gemini CLI through the user's existing login on the
 * machine. The other ACP (IBM/BeeAI Agent Communication
 * Protocol) merged into A2A in 08/2025 and is NOT spoken here;
 * the Agentic Commerce Protocol is out of scope (no payments,
 * local-first, per the standing direction).
 *
 * What v9 adds over v8 (all open-bot layers, written from
 * those descriptions — no code, text or asset from any other
 * repo is copied here):
 *  - MCP Apps v2: the v8 host rendered one `ui://` resource
 *    into a sandbox descriptor; v9 adds the app lifecycle
 *    (open / close / reopen / suspend / resume / focus),
 *    panel slots, and a durable snapshot of open apps.
 *  - ACP agent sessions: detection of the CLI agents already
 *    installed on the machine (binary on PATH + login-marker
 *    file presence — the marker is only ever checked for
 *    existence, never read, and no credential is copied or
 *    sent anywhere), plus create / resume / cancel / prompt
 *    sessions with durable state.
 *  - A2A v9: Agent Card discovery over a local registry,
 *    delegation with capability matching, message + artifact
 *    exchange, and the full task lifecycle — loopback-only.
 *    Any non-loopback URL is refused before anything is sent.
 *
 * Version rules (v9):
 * - mcp: `2026-07-28` is current (unchanged from v8).
 * - a2a: `1.1` is now the implemented track (v8 implemented
 *   1.0.1 and tracked 1.1 as newer-final; v9 implements the
 *   1.1 delegation surface: task + message + artifact).
 * - acp: `draft` — the Agent Client Protocol has no versioned
 *   stable release in the survey; open-bot tracks it as a
 *   draft client track and versions its own implementation
 *   as `9.0` below. The merged IBM/BeeAI ACP is `merged`
 *   and is never negotiated.
 * - ucp: `2026-08-25` read-only (unchanged from v7/v8).
 * - gov: `1.0` (unchanged). nanda: `0.1-local` (unchanged).
 * - agui / a2ui: `1.0` current (unchanged).
 * - poppy: `1.0` watch-only (unchanged).
 */

export const PROTOCOL_V9_FAMILIES = [
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
export type ProtocolV9Family = (typeof PROTOCOL_V9_FAMILIES)[number];

/** A2A versions open-bot speaks; v9 implements the 1.1 track. */
export const A2A_V9_VERSIONS = ['1.1', '1.0.1', '1.0', '0.3', '0.2'] as const;
export const A2A_V9_CURRENT_VERSION = '1.1';
export const A2A_V9_IMPLEMENTED_VERSION = '1.1';
export const A2A_V9_PREVIOUS_VERSION = '1.0.1';
export const A2A_V9_LEGACY_VERSIONS = ['1.0'] as const;
export const A2A_V9_REMOVED_VERSIONS = ['0.3', '0.2'] as const;

/** MCP core version (spec 2026-07-28) — unchanged from v8. */
export const MCP_V9_CURRENT_VERSION = '2026-07-28';
export const MCP_V9_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V9_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build (from v8). */
export const MCP_V9_LEGACY_REMOVAL_DATE = '2027-07-28';
export const MCP_V9_STATELESS = true as const;

/**
 * ACP (Agent Client Protocol, Zed) track. The protocol itself
 * is a draft with no versioned stable release, so open-bot
 * negotiates the single token `draft` and versions only its
 * own client implementation (`9.0`, this layer).
 */
export const ACP_V9_VERSIONS = ['draft'] as const;
export const ACP_V9_CURRENT_VERSION = 'draft';
export const ACP_V9_IMPLEMENTATION_VERSION = '9.0';
/** The IBM/BeeAI ACP merged into A2A — never negotiated. */
export const ACP_V9_MERGED_TRACK = 'merged' as const;
/** CLI agents the ACP session layer knows how to map. */
export const ACP_V9_KNOWN_AGENTS = ['claude', 'codex', 'gemini'] as const;
export type AcpV9KnownAgent = (typeof ACP_V9_KNOWN_AGENTS)[number];
/** ACP session permission modes (client-side policy, not a protocol version). */
export const ACP_V9_PERMISSION_MODES = ['ask', 'auto', 'read-only'] as const;
export type AcpV9PermissionMode = (typeof ACP_V9_PERMISSION_MODES)[number];

/** UCP stays read-only (unchanged from v7/v8). */
export const UCP_V9_CURRENT_VERSION = '2026-08-25';
export const UCP_V9_MODE = 'read-only' as const;
/** Governance layer version (unchanged). */
export const GOV_V9_CURRENT_VERSION = '1.0';
/** NANDA local sketch version (unchanged). */
export const NANDA_V9_CURRENT_VERSION = '0.1-local';
/** AG-UI / A2UI current versions (unchanged). */
export const AGUI_V9_CURRENT_VERSION = '1.0';
export const A2UI_V9_CURRENT_VERSION = '1.0';
/** Poppy is watch-only (unchanged). */
export const POPPY_V9_CURRENT_VERSION = '1.0';
export const POPPY_V9_STATUS = 'watch-only' as const;

/** Current version per family (the v9 matrix). */
export const PROTOCOL_V9_CURRENT_VERSIONS: Record<ProtocolV9Family, string> = {
  a2a: A2A_V9_CURRENT_VERSION,
  mcp: MCP_V9_CURRENT_VERSION,
  ucp: UCP_V9_CURRENT_VERSION,
  acp: ACP_V9_CURRENT_VERSION,
  gov: GOV_V9_CURRENT_VERSION,
  agui: AGUI_V9_CURRENT_VERSION,
  a2ui: A2UI_V9_CURRENT_VERSION,
  poppy: POPPY_V9_CURRENT_VERSION,
  nanda: NANDA_V9_CURRENT_VERSION,
};

/** All versions open-bot accepts per family (newest first). */
export const PROTOCOL_V9_VERSION_MATRIX: Record<ProtocolV9Family, readonly string[]> = {
  a2a: A2A_V9_VERSIONS,
  mcp: MCP_V9_VERSIONS,
  ucp: [UCP_V9_CURRENT_VERSION],
  acp: ACP_V9_VERSIONS,
  gov: [GOV_V9_CURRENT_VERSION],
  agui: [AGUI_V9_CURRENT_VERSION],
  a2ui: [A2UI_V9_CURRENT_VERSION],
  poppy: [POPPY_V9_CURRENT_VERSION],
  nanda: [NANDA_V9_CURRENT_VERSION],
};

/** One-line summary of the v9 matrix, for the UI / logs. */
export function protocolV9MatrixSummary(): string {
  return PROTOCOL_V9_FAMILIES.map(
    (family) => `${family} ${PROTOCOL_V9_CURRENT_VERSIONS[family]}`,
  ).join(', ');
}

/** Result of negotiating one family with a peer. */
export interface ProtocolV9Negotiation {
  family: ProtocolV9Family;
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
export function negotiateProtocolV9Version(
  family: ProtocolV9Family,
  serverVersions: readonly string[],
): ProtocolV9Negotiation {
  const local = PROTOCOL_V9_VERSION_MATRIX[family] ?? [];
  const peer = [...new Set(serverVersions.filter((v) => typeof v === 'string'))];
  const agreed = local.find((v) => peer.includes(v));
  return {
    family,
    agreed,
    peerHasCurrent: peer.includes(PROTOCOL_V9_CURRENT_VERSIONS[family]),
    peerOnly: peer.filter((v) => !local.includes(v)),
    localOnly: local.filter((v) => !peer.includes(v)),
  };
}

/** Negotiate every family at once (missing families = no peer offer). */
export function negotiateAllProtocolsV9(
  offered: Partial<Record<ProtocolV9Family, readonly string[]>>,
): Record<ProtocolV9Family, ProtocolV9Negotiation> {
  const out = {} as Record<ProtocolV9Family, ProtocolV9Negotiation>;
  for (const family of PROTOCOL_V9_FAMILIES) {
    out[family] = negotiateProtocolV9Version(family, offered[family] ?? []);
  }
  return out;
}

/** What changed from protocols v8 to v9 (for the UI / changelog). */
export function protocolV9ChangesSinceV8(): string[] {
  return [
    'a2a: implemented track moves 1.0.1 -> 1.1 (task delegation + message + artifact exchange, loopback-only).',
    'mcp: Apps v2 — app lifecycle (open / close / reopen / suspend / resume / focus), panel slots, durable app snapshots; v8 render + CSP unchanged.',
    'acp: Agent Client Protocol sessions — CLI agent detection (claude / codex / gemini via existing login, credentials never copied), create / resume / cancel / prompt sessions with durable state.',
    'a2a: Agent Card discovery over a local registry + well-known URL builder; delegation with capability matching; loopback guard refuses any non-loopback URL.',
    'acp: the IBM/BeeAI Agent Communication Protocol stays merged into A2A and is never negotiated; Agentic Commerce Protocol stays out of scope (no payments).',
    'mcp / ucp / gov / agui / a2ui / poppy / nanda: versions unchanged from v8.',
  ];
}

/** What a v9 peer loses when it downgrades to v8. */
export function protocolV9DowngradeToV8(): Record<string, string> {
  return {
    a2a: '1.1 -> 1.0.1: v9 delegation (capability-matched delegate, artifact exchange, loopback guard) is unavailable; v8 task lifecycle still works.',
    mcp: 'Apps v2 lifecycle (open/close/reopen/suspend/resume/focus, panel slots, snapshots) is unavailable; v8 render + CSP still works.',
    acp: 'Agent Client Protocol sessions are unavailable in v8 (v8 has no ACP session layer); CLI detection and resume are v9-only.',
    ucp: 'unchanged (2026-08-25 read-only).',
    gov: 'unchanged (1.0).',
    agui: 'unchanged (1.0).',
    a2ui: 'unchanged (1.0).',
    poppy: 'unchanged (1.0, watch-only).',
    nanda: 'unchanged (0.1-local).',
  };
}

/** Feature flags for the v9 additions (all on by default, local-only). */
export interface ProtocolV9FeatureFlags {
  /** MCP Apps v2 lifecycle manager. */
  mcpAppsV2: boolean;
  /** ACP agent sessions. */
  acpSessions: boolean;
  /** A2A v9 delegation + cards. */
  a2aDelegation: boolean;
  /** Loopback guard (must stay on: A2A is local-only). */
  loopbackOnly: boolean;
}

export const PROTOCOL_V9_DEFAULT_FEATURES: ProtocolV9FeatureFlags = {
  mcpAppsV2: true,
  acpSessions: true,
  a2aDelegation: true,
  loopbackOnly: true,
};

/**
 * Validate feature flags: the loopback guard may never be
 * switched off — A2A in open-bot is local/loopback only.
 * Returns problems (empty when valid).
 */
export function validateProtocolV9Features(flags: ProtocolV9FeatureFlags): string[] {
  const problems: string[] = [];
  if (flags.loopbackOnly !== true) {
    problems.push('loopbackOnly must stay true: A2A delegation is local/loopback only and must never reach the public internet.');
  }
  return problems;
}

/** A2A v9 artifact kinds (message + artifact exchange). */
export const A2A_V9_ARTIFACT_KINDS = ['text', 'file', 'data', 'image'] as const;
export type A2aV9ArtifactKind = (typeof A2A_V9_ARTIFACT_KINDS)[number];

/** A2A v9 task states (same machine as v7/v8: terminal states never move). */
export const A2A_V9_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;
export type A2aV9TaskState = (typeof A2A_V9_TASK_STATES)[number];
export const A2A_V9_TERMINAL_TASK_STATES: readonly A2aV9TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];
export function isA2aV9TaskTerminal(state: A2aV9TaskState): boolean {
  return (A2A_V9_TERMINAL_TASK_STATES as readonly A2aV9TaskState[]).includes(state);
}

/** Legal transitions of the A2A v9 task state machine. */
export const A2A_V9_TASK_TRANSITIONS: Record<A2aV9TaskState, readonly A2aV9TaskState[]> = {
  submitted: ['working', 'input-required', 'canceled', 'rejected', 'failed'],
  working: ['working', 'input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'canceled', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export function isA2aV9TaskTransitionLegal(from: A2aV9TaskState, to: A2aV9TaskState): boolean {
  return (A2A_V9_TASK_TRANSITIONS[from] as readonly A2aV9TaskState[]).includes(to);
}

/** MCP Apps v2 app-instance states. */
export const MCP_V9_APP_STATES = [
  'opening',
  'active',
  'suspended',
  'closed',
  'failed',
] as const;
export type McpV9AppState = (typeof MCP_V9_APP_STATES)[number];

/** ACP session states (v9 extends the v6 set with suspended + resumed tracking). */
export const ACP_V9_SESSION_STATUSES = [
  'active',
  'idle',
  'suspended',
  'cancelled',
  'completed',
  'failed',
] as const;
export type AcpV9SessionStatus = (typeof ACP_V9_SESSION_STATUSES)[number];
export const ACP_V9_SESSION_TERMINAL: readonly AcpV9SessionStatus[] = [
  'cancelled',
  'completed',
  'failed',
];
export function isAcpV9SessionTerminal(status: AcpV9SessionStatus): boolean {
  return (ACP_V9_SESSION_TERMINAL as readonly AcpV9SessionStatus[]).includes(status);
}
