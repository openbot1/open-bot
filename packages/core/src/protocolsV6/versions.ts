/**
 * Protocols v6 — version matrix + unified negotiation (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md:
 *  - ACP v2 is still a draft (ACP v1 stays the stable track); the
 *    v2 draft replaces the oldText/newText diff with structured
 *    file changes, lets `session/update` arrive outside a prompt
 *    turn, and makes `session/prompt` return the user message id.
 *    The ACP team asks implementers to keep supporting v1 in
 *    parallel with v2 — so v6 runs the v2 draft ALONGSIDE v1 and
 *    never replaces it.
 *  - Elicitation is now stable (Completed RFD): structured forms
 *    plus a URL mode, with the client advertising which modes it
 *    supports. The stable elicitation machine lives in
 *    `elicitationV6.ts`; this file only records the versions.
 *  - A2A 1.1 is the current stable track (final under the Linux
 *    Foundation); its two-way streaming for a running task is the
 *    behaviour model for `a2aStreamingV6.ts`.
 *  - Poppy 1.0 (Personal Agent Protocol, 13/11/2026) is brand new
 *    — open-bot only WATCHES it. The registry records it as
 *    "watch, not implemented" (`registryV6.ts`); nothing in v6
 *    implements Poppy, and this matrix must never claim otherwise.
 *  - The IETF Agent Communication Protocols working group
 *    (chartered 10/2026) aims at one base protocol MCP and A2A can
 *    both carry; v6 tracks it as a watch entry, not a protocol it
 *    speaks.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the v5 matrix (`protocolsV5/versions.ts`)
 * without touching it: v5 pins ACP `2.0-draft` as current and
 * A2A `1.1` as current; v6 keeps those currents, promotes the
 * elicitation surface to stable, and adds the v6-only negotiation
 * (capability advertisement for elicitation modes and A2A
 * two-way streaming) on top.
 *
 * Version rules (v6):
 * - acp: `2.0-draft` is current (draft — unstable); `1.0` legacy.
 * - a2a: `1.1` is current (final, Linux Foundation); `1.1-rc` is
 *   legacy-but-compatible; `1.0` legacy; `0.3`/`0.2` removed.
 * - mcp: `2026-07-28` current; legacy versions leave the default
 *   surface on 2027-07-28.
 * - agui: `1.0` current; `0.0.1` legacy.
 * - a2ui: `1.0` current; `0.1` legacy.
 * - poppy: `1.0` current in the wider world — but open-bot does
 *   NOT implement it (watch-only). The matrix lists it so peers
 *   can be described, never so a Poppy session can be opened.
 */

export const PROTOCOL_V6_FAMILIES = ['acp', 'poppy', 'mcp', 'a2a', 'agui', 'a2ui'] as const;
export type ProtocolV6Family = (typeof PROTOCOL_V6_FAMILIES)[number];

/** ACP versions open-bot speaks. `2.0-draft` is a draft, not final. */
export const ACP_V6_VERSIONS = ['2.0-draft', '1.0'] as const;
export const ACP_V6_CURRENT_VERSION = '2.0-draft';
export const ACP_V6_DRAFT_VERSIONS = ['2.0-draft'] as const;
export const ACP_V6_LEGACY_VERSIONS = ['1.0'] as const;
/** ACP v1 — the stable track, still supported in parallel with the v2 draft. */
export const ACP_V6_STABLE_VERSION = '1.0';
/** ACP v2 draft: the client<->agent wire, aligned with A2A. */
export const ACP_V6_DESCRIPTION =
  'Agent Client Protocol v2 draft (Linux Foundation, merged with A2A): the client<->agent wire — sessions, prompts, tool calls and permission requests between a client and one agent.';
/** Well-known discovery path for an ACP agent (draft convention). */
export const ACP_V6_DISCOVERY_PATH = '/.well-known/acp.json';
/** JSON-RPC methods an ACP v2 client may send (draft surface, v6). */
export const ACP_V6_METHODS = [
  'session/new',
  'session/load',
  'session/prompt',
  'session/update',
  'session/cancel',
  'agent/authenticate',
  'fs/read_text_file',
  'fs/write_text_file',
] as const;
export type AcpV6Method = (typeof ACP_V6_METHODS)[number];
/** Methods that are new in the v2 draft versus ACP v1. */
export const ACP_V6_DRAFT_ONLY_METHODS = ['session/update'] as const;
/**
 * Methods the v2 draft changed versus v1: `session/prompt` now
 * returns the user message id, and file edits arrive as
 * structured file changes instead of oldText/newText diffs.
 */
export const ACP_V6_CHANGED_METHODS = ['session/prompt', 'fs/write_text_file'] as const;

/** Poppy versions known to open-bot. WATCH-ONLY — not implemented. */
export const POPPY_V6_VERSIONS = ['1.0', '0.2', '0.1'] as const;
export const POPPY_V6_CURRENT_VERSION = '1.0';
export const POPPY_V6_DRAFT_VERSIONS = ['0.2', '0.1'] as const;
export const POPPY_V6_DISCOVERY_PATH = '/.well-known/poppy.json';
export const POPPY_V6_SCOPES = ['poppy:read', 'poppy:write'] as const;
export type PoppyV6Scope = (typeof POPPY_V6_SCOPES)[number];
/** Poppy implementation status in open-bot: tracked, never spoken. */
export const POPPY_V6_IMPLEMENTATION_STATUS = 'watch-only' as const;
export const POPPY_V6_IMPLEMENTATION_NOTE =
  'Poppy: watch-only, not implemented. Poppy 1.0 (Personal Agent Protocol, 13/11/2026) is tracked in the v6 registry only; open-bot opens no Poppy session and speaks no Poppy method.';

/** MCP core version (spec 2026-07-28). */
export const MCP_V6_CURRENT_VERSION = '2026-07-28';
export const MCP_V6_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V6_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V6_LEGACY_REMOVAL_DATE = '2027-07-28';
/** Earliest removal of deprecated MCP features (SEP-2577). */
export const MCP_V6_DEPRECATED_REMOVAL_FLOOR = '2027-07-28';
/** Elicitation is stable in v6 (Completed RFD): form + URL modes. */
export const MCP_V6_ELICITATION_STATUS = 'stable' as const;
export const MCP_V6_ELICITATION_MODES = ['form', 'url'] as const;
export type McpV6ElicitationMode = (typeof MCP_V6_ELICITATION_MODES)[number];

/** A2A versions: 1.1 is final now (Linux Foundation). */
export const A2A_V6_VERSIONS = ['1.1', '1.1-rc', '1.0', '0.3', '0.2'] as const;
export const A2A_V6_CURRENT_VERSION = '1.1';
export const A2A_V6_STABLE_VERSION = '1.1';
export const A2A_V6_LEGACY_VERSIONS = ['1.1-rc', '1.0'] as const;
export const A2A_V6_REMOVED_VERSIONS = ['0.3', '0.2'] as const;
export const A2A_V6_AGENT_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
export const A2A_V6_SEND_LIVE_MESSAGE_METHOD = 'message/sendLive';
/** A2A is now governed under the Linux Foundation (ACP merged in). */
export const A2A_V6_GOVERNANCE = 'Linux Foundation';
/** A2A 1.1 two-way streaming is supported in v6 (see a2aStreamingV6). */
export const A2A_V6_TWO_WAY_STREAMING = true as const;

/** AG-UI 1.0 is current in v6. */
export const AGUI_V6_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V6_CURRENT_VERSION = '1.0';
export const AGUI_V6_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v6. */
export const A2UI_V6_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V6_CURRENT_VERSION = '1.0';
export const A2UI_V6_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. */
export const PROTOCOL_V6_CURRENT_VERSIONS: Record<ProtocolV6Family, string> = {
  acp: ACP_V6_CURRENT_VERSION,
  poppy: POPPY_V6_CURRENT_VERSION,
  mcp: MCP_V6_CURRENT_VERSION,
  a2a: A2A_V6_CURRENT_VERSION,
  agui: AGUI_V6_CURRENT_VERSION,
  a2ui: A2UI_V6_CURRENT_VERSION,
};

/** All known versions per family, newest first. */
export const PROTOCOL_V6_VERSION_MATRIX: Record<ProtocolV6Family, readonly string[]> = {
  acp: ACP_V6_VERSIONS,
  poppy: POPPY_V6_VERSIONS,
  mcp: MCP_V6_VERSIONS,
  a2a: A2A_V6_VERSIONS,
  agui: AGUI_V6_VERSIONS,
  a2ui: A2UI_V6_VERSIONS,
};

/** Legacy (supported but deprecated / draft) versions per family. */
export const PROTOCOL_V6_LEGACY_VERSIONS: Record<ProtocolV6Family, readonly string[]> = {
  acp: ACP_V6_LEGACY_VERSIONS,
  poppy: POPPY_V6_DRAFT_VERSIONS,
  mcp: MCP_V6_LEGACY_VERSIONS,
  a2a: A2A_V6_LEGACY_VERSIONS,
  agui: AGUI_V6_LEGACY_VERSIONS,
  a2ui: A2UI_V6_LEGACY_VERSIONS,
};

/** Lifecycle of one protocol version. */
export type ProtocolV6VersionStatus = 'current' | 'legacy' | 'removed' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV6VersionError extends Error {
  readonly family: ProtocolV6Family;
  readonly code: string;
  constructor(family: ProtocolV6Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV6VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` version (ACP / Poppy / A2A / AG-UI / A2UI), or null. */
export function parseProtocolV6Semver(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?(?:-([a-z]+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Parse an MCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseMcpV6DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV6Versions(
  family: ProtocolV6Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp') {
    const na = parseMcpV6DateVersion(a);
    const nb = parseMcpV6DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  // `2.0-draft` sorts below final `2.0` and above `1.0`; same for `1.1-rc`.
  // A draft/RC ranks below its own final version (0 < 1).
  const rank = (v: string): number => {
    if (v.endsWith('-draft') || v.endsWith('-rc')) return 0;
    return 1;
  };
  const pa = parseProtocolV6Semver(a);
  const pb = parseProtocolV6Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV6VersionStatus(
  family: ProtocolV6Family,
  version: string,
): ProtocolV6VersionStatus {
  const matrix = PROTOCOL_V6_VERSION_MATRIX[family];
  if (!matrix.includes(version as never)) return 'unknown';
  if (family === 'a2a' && (A2A_V6_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if (version === PROTOCOL_V6_CURRENT_VERSIONS[family]) return 'current';
  if ((PROTOCOL_V6_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  return 'unknown';
}

/** True when the version is a draft / RC that may change incompatibly. */
export function protocolV6VersionIsUnstable(family: ProtocolV6Family, version: string): boolean {
  if (family === 'acp') return (ACP_V6_DRAFT_VERSIONS as readonly string[]).includes(version);
  if (family === 'poppy') return (POPPY_V6_DRAFT_VERSIONS as readonly string[]).includes(version);
  if (family === 'a2a') return version === '1.1-rc';
  return false;
}

/** True when open-bot actually implements (speaks) a family/version. */
export function protocolV6IsImplemented(family: ProtocolV6Family, version?: string): boolean {
  // Poppy is watch-only: listed in the matrix, implemented nowhere.
  if (family === 'poppy') return false;
  if (version === undefined) return true;
  return protocolV6VersionStatus(family, version) !== 'unknown'
    && protocolV6VersionStatus(family, version) !== 'removed';
}

/** One family's negotiation result. */
export interface ProtocolV6Negotiation {
  family: ProtocolV6Family;
  negotiated: string | null;
  status: ProtocolV6VersionStatus;
  /** True when the negotiated version is a draft / RC (may change). */
  unstable: boolean;
  /** True when open-bot implements the negotiated version (false for Poppy). */
  implemented: boolean;
  /** Human-readable note for the UI (empty when clean). */
  note: string;
}

/**
 * Negotiate one family's version: pick the highest version both
 * sides speak. `serverVersions` is what the peer offers (newest
 * first); the local matrix is the authority for what is current /
 * legacy / removed. Returns `negotiated: null` when nothing overlaps.
 * A removed version is never picked even when both sides list it.
 * Poppy negotiates a version for description purposes only — the
 * result is always marked `implemented: false`.
 */
export function negotiateProtocolV6Version(
  family: ProtocolV6Family,
  serverVersions: readonly string[] | undefined,
): ProtocolV6Negotiation {
  const local = PROTOCOL_V6_VERSION_MATRIX[family];
  const offered = serverVersions ?? [];
  for (const candidate of local) {
    if (!offered.includes(candidate)) continue;
    const status = protocolV6VersionStatus(family, candidate);
    if (status === 'removed') continue;
    const unstable = protocolV6VersionIsUnstable(family, candidate);
    const implemented = protocolV6IsImplemented(family, candidate);
    return {
      family,
      negotiated: candidate,
      status,
      unstable,
      implemented,
      note: family === 'poppy'
        ? `Poppy ${candidate} is watch-only in open-bot (not implemented); do not open a Poppy session.`
        : unstable
          ? `${family} ${candidate} is a draft / release candidate and may change incompatibly.`
          : status === 'legacy'
            ? `${family} ${candidate} is legacy; upgrade to ${PROTOCOL_V6_CURRENT_VERSIONS[family]}.`
            : '',
    };
  }
  return {
    family,
    negotiated: null,
    status: 'unknown',
    unstable: false,
    implemented: false,
    note: `No common ${family} version (local: ${local.join(', ')}; peer: ${offered.join(', ') || 'none'}).`,
  };
}

/** Negotiate every family at once. */
export function negotiateAllProtocolsV6(
  serverVersions: Partial<Record<ProtocolV6Family, readonly string[]>>,
): Record<ProtocolV6Family, ProtocolV6Negotiation> {
  const out = {} as Record<ProtocolV6Family, ProtocolV6Negotiation>;
  for (const family of PROTOCOL_V6_FAMILIES) {
    out[family] = negotiateProtocolV6Version(family, serverVersions[family]);
  }
  return out;
}

/** Capability advertisement: what this client supports beyond bare versions. */
export interface ProtocolV6CapabilityAdvertisement {
  /** Elicitation modes the client supports (client advertises; agent picks). */
  elicitationModes: McpV6ElicitationMode[];
  /** A2A 1.1 two-way streaming supported for running tasks. */
  a2aTwoWayStreaming: boolean;
  /** ACP v2 draft structured file changes supported. */
  acpStructuredFileChanges: boolean;
  /** ACP v2 session/update outside a prompt turn supported. */
  acpOutOfTurnUpdates: boolean;
  /** ACP v2 session/prompt returning a message id supported. */
  acpPromptMessageIds: boolean;
  /** ACP v1 still supported in parallel with the v2 draft. */
  acpV1Parallel: boolean;
}

/** The default capability advertisement for open-bot v6. */
export function defaultProtocolV6Capabilities(): ProtocolV6CapabilityAdvertisement {
  return {
    elicitationModes: [...MCP_V6_ELICITATION_MODES],
    a2aTwoWayStreaming: true,
    acpStructuredFileChanges: true,
    acpOutOfTurnUpdates: true,
    acpPromptMessageIds: true,
    acpV1Parallel: true,
  };
}

/**
 * Negotiate capabilities against a peer's advertisement: the
 * intersection is what both sides may use. A missing peer
 * advertisement means "nothing beyond versions" (safe default).
 */
export function negotiateProtocolV6Capabilities(
  peer: Partial<ProtocolV6CapabilityAdvertisement> | undefined,
): ProtocolV6CapabilityAdvertisement {
  const local = defaultProtocolV6Capabilities();
  if (!peer) {
    return {
      elicitationModes: [],
      a2aTwoWayStreaming: false,
      acpStructuredFileChanges: false,
      acpOutOfTurnUpdates: false,
      acpPromptMessageIds: false,
      acpV1Parallel: false,
    };
  }
  return {
    elicitationModes: local.elicitationModes.filter((m) => (peer.elicitationModes ?? []).includes(m)),
    a2aTwoWayStreaming: local.a2aTwoWayStreaming && peer.a2aTwoWayStreaming === true,
    acpStructuredFileChanges: local.acpStructuredFileChanges && peer.acpStructuredFileChanges === true,
    acpOutOfTurnUpdates: local.acpOutOfTurnUpdates && peer.acpOutOfTurnUpdates === true,
    acpPromptMessageIds: local.acpPromptMessageIds && peer.acpPromptMessageIds === true,
    acpV1Parallel: local.acpV1Parallel && peer.acpV1Parallel === true,
  };
}

/**
 * Downgrade check: can a v6 client talk to a peer that only speaks
 * the v5 matrix? Returns the families that still negotiate and the
 * ones that lose their current version (nothing is lost — v5 and v6
 * share the same currents; only the v6-only capabilities are
 * unavailable with a v5 peer).
 */
export interface ProtocolV6DowngradeReport {
  family: ProtocolV6Family;
  v6Current: string;
  v5Negotiated: string | null;
  compatible: boolean;
  implemented: boolean;
  note: string;
}

export function protocolV6DowngradeToV5(): ProtocolV6DowngradeReport[] {
  const v5Offered: Partial<Record<ProtocolV6Family, readonly string[]>> = {
    acp: ['2.0-draft', '1.0'],
    poppy: ['1.0', '0.2', '0.1'],
    mcp: ['2026-07-28', '2025-11-25'],
    a2a: ['1.1', '1.1-rc', '1.0'],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
  };
  return PROTOCOL_V6_FAMILIES.map((family) => {
    const negotiated = negotiateProtocolV6Version(family, v5Offered[family]);
    const compatible = negotiated.negotiated !== null;
    return {
      family,
      v6Current: PROTOCOL_V6_CURRENT_VERSIONS[family],
      v5Negotiated: negotiated.negotiated,
      compatible,
      implemented: negotiated.implemented,
      note:
        family === 'poppy'
          ? 'Poppy is watch-only in both v5 and v6; no Poppy session is ever opened.'
          : compatible
            ? `Negotiates ${negotiated.negotiated} with a v5 peer${negotiated.unstable ? ' (draft/RC)' : ''}; v6-only capabilities (structured file changes, out-of-turn updates, message ids, stable elicitation, A2A two-way streaming) are unavailable with a v5 peer.`
            : `No common ${family} version with a v5 peer.`,
    };
  });
}

/**
 * Deprecation calendar for the v6 surface — one row per family, so
 * the UI can say what is current, what is legacy-but-supported and
 * what is removed, and when the legacy surface leaves.
 */
export interface ProtocolV6DeprecationRow {
  family: ProtocolV6Family;
  current: string;
  legacy: readonly string[];
  removed: readonly string[];
  removalDate: string;
  note: string;
}

export function protocolV6DeprecationCalendar(): ProtocolV6DeprecationRow[] {
  return [
    {
      family: 'acp',
      current: ACP_V6_CURRENT_VERSION,
      legacy: ACP_V6_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: 'ACP v2 is a draft under the Linux Foundation (merged with A2A); it may change incompatibly before final. ACP v1 stays supported in parallel — v2 never replaces it.',
    },
    {
      family: 'poppy',
      current: POPPY_V6_CURRENT_VERSION,
      legacy: POPPY_V6_DRAFT_VERSIONS,
      removed: [],
      removalDate: '',
      note: POPPY_V6_IMPLEMENTATION_NOTE,
    },
    {
      family: 'mcp',
      current: MCP_V6_CURRENT_VERSION,
      legacy: MCP_V6_LEGACY_VERSIONS,
      removed: [],
      removalDate: MCP_V6_LEGACY_REMOVAL_DATE,
      note: `Sampling / roots / logging deprecated (SEP-2577); earliest removal ${MCP_V6_DEPRECATED_REMOVAL_FLOOR}. Elicitation is stable (form + URL modes).`,
    },
    {
      family: 'a2a',
      current: A2A_V6_CURRENT_VERSION,
      legacy: A2A_V6_LEGACY_VERSIONS,
      removed: A2A_V6_REMOVED_VERSIONS,
      removalDate: '',
      note: `1.1 is final (${A2A_V6_GOVERNANCE}); 1.1-rc stays compatible; two-way streaming for running tasks is supported in v6.`,
    },
    {
      family: 'agui',
      current: AGUI_V6_CURRENT_VERSION,
      legacy: AGUI_V6_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '1.0 freezes 31 event types; THINKING_* removed, use REASONING_*.',
    },
    {
      family: 'a2ui',
      current: A2UI_V6_CURRENT_VERSION,
      legacy: A2UI_V6_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '',
    },
  ];
}

/** One-line summary of the v6 matrix, for logs and the UI. */
export function protocolV6MatrixSummary(): string {
  return PROTOCOL_V6_FAMILIES.map(
    (f) => `${f} ${PROTOCOL_V6_CURRENT_VERSIONS[f]}`,
  ).join(' · ');
}

/**
 * What changed between the v5 and v6 matrices (for the changelog
 * and the UI): same currents everywhere, plus the v6-only
 * capabilities and the stable elicitation + watch-only Poppy note.
 */
export function protocolV6ChangesSinceV5(): string[] {
  return [
    'ACP v2 draft: structured file changes replace oldText/newText diffs (session/prompt still returns a message id; session/update arrives outside a prompt turn).',
    'ACP v1 keeps running in parallel with the v2 draft — v2 never replaces v1.',
    'Elicitation is stable: structured form + URL mode, with client capability advertisement.',
    'A2A 1.1 two-way streaming for running tasks (cancel / resume mid-task).',
    'Poppy 1.0: watch-only, not implemented (registry note only).',
    'IETF Agent Communication Protocols working group: tracked as a watch entry.',
  ];
}
