/**
 * Protocols v5 — version matrix + unified negotiation (v1.29, Team T2).
 *
 * Idea only, learned from the public protocol descriptions researched
 * for this wave (see docs/repo-survey-v129.md):
 *  - ACP (Agent Client Protocol) merged into A2A under the Linux
 *    Foundation: ACP is the client<->agent wire (the "LSP for
 *    agents"), A2A the agent<->agent wire; the v2 draft aligns the
 *    two instead of competing with them. ACP v2 is a draft — any
 *    part may change incompatibly, so it is negotiated as an
 *    opt-in capability, never assumed.
 *  - A2A 1.1 is now the current stable track (the 1.1 RC of v4 has
 *    landed as final under the Linux Foundation); 1.0 stays legacy.
 *  - MCP 2026-07-28 stays current; sampling / roots / logging are
 *    deprecated with the earliest removal floor 2027-07-28 (SEP-2577).
 *  - Claude Agent SDK 0.3.319 background MCP tasks + 0.3.301
 *    per-tool permission_policy are the behaviour models for the
 *    sibling modules in this folder (mcpBackgroundTasksV5,
 *    mcpPermissionPolicyV5, mcpOAuthElicitationV5) — this file only
 *    records the versions those behaviours belong to.
 *  - AG-UI 1.0 / A2UI 1.0 / Poppy 1.0 unchanged from v4.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the v4 matrix (`protocolsV4/versions.ts`) without
 * touching it: v4 pins A2A `1.1-rc` as current; v5 promotes A2A
 * `1.1` to current, adds the `acp` family (`2.0-draft` current,
 * `1.0` legacy), and keeps every other family identical so a v4
 * peer still negotiates cleanly.
 *
 * Version rules (v5):
 * - acp: `2.0-draft` is current (draft — unstable); `1.0` legacy.
 * - a2a: `1.1` is current (final, Linux Foundation); `1.1-rc` is
 *   legacy-but-compatible; `1.0` legacy; `0.3`/`0.2` removed.
 * - mcp: `2026-07-28` current; legacy versions leave the default
 *   surface on 2027-07-28 (same floor as the sampling / roots /
 *   logging removal).
 * - agui: `1.0` current; `0.0.1` legacy.
 * - a2ui: `1.0` current; `0.1` legacy.
 * - poppy: `1.0` current; `0.2` / `0.1` draft (legacy).
 */

export const PROTOCOL_V5_FAMILIES = ['acp', 'poppy', 'mcp', 'a2a', 'agui', 'a2ui'] as const;
export type ProtocolV5Family = (typeof PROTOCOL_V5_FAMILIES)[number];

/** ACP versions open-bot speaks. `2.0-draft` is a draft, not final. */
export const ACP_V5_VERSIONS = ['2.0-draft', '1.0'] as const;
export const ACP_V5_CURRENT_VERSION = '2.0-draft';
export const ACP_V5_DRAFT_VERSIONS = ['2.0-draft'] as const;
export const ACP_V5_LEGACY_VERSIONS = ['1.0'] as const;
/** ACP v2 draft: the client<->agent wire, aligned with A2A. */
export const ACP_V5_DESCRIPTION =
  'Agent Client Protocol v2 draft (Linux Foundation, merged with A2A): the client<->agent wire — sessions, prompts, tool calls and permission requests between a client and one agent.';
/** Well-known discovery path for an ACP agent (draft convention). */
export const ACP_V5_DISCOVERY_PATH = '/.well-known/acp.json';
/** JSON-RPC methods an ACP v2 client may send (draft surface). */
export const ACP_V5_METHODS = [
  'session/new',
  'session/load',
  'session/prompt',
  'session/cancel',
  'agent/authenticate',
  'fs/read_text_file',
  'fs/write_text_file',
] as const;
export type AcpV5Method = (typeof ACP_V5_METHODS)[number];

/** Poppy versions open-bot speaks. */
export const POPPY_V5_VERSIONS = ['1.0', '0.2', '0.1'] as const;
export const POPPY_V5_CURRENT_VERSION = '1.0';
export const POPPY_V5_DRAFT_VERSIONS = ['0.2', '0.1'] as const;
export const POPPY_V5_DISCOVERY_PATH = '/.well-known/poppy.json';
export const POPPY_V5_SCOPES = ['poppy:read', 'poppy:write'] as const;
export type PoppyV5Scope = (typeof POPPY_V5_SCOPES)[number];

/** MCP core version (spec 2026-07-28). */
export const MCP_V5_CURRENT_VERSION = '2026-07-28';
export const MCP_V5_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V5_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V5_LEGACY_REMOVAL_DATE = '2027-07-28';
/** Earliest removal of deprecated MCP features (SEP-2577). */
export const MCP_V5_DEPRECATED_REMOVAL_FLOOR = '2027-07-28';

/** A2A versions: 1.1 is final now (Linux Foundation). */
export const A2A_V5_VERSIONS = ['1.1', '1.1-rc', '1.0', '0.3', '0.2'] as const;
export const A2A_V5_CURRENT_VERSION = '1.1';
export const A2A_V5_STABLE_VERSION = '1.1';
export const A2A_V5_LEGACY_VERSIONS = ['1.1-rc', '1.0'] as const;
export const A2A_V5_REMOVED_VERSIONS = ['0.3', '0.2'] as const;
export const A2A_V5_AGENT_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
export const A2A_V5_SEND_LIVE_MESSAGE_METHOD = 'message/sendLive';
/** A2A is now governed under the Linux Foundation (ACP merged in). */
export const A2A_V5_GOVERNANCE = 'Linux Foundation';

/** AG-UI 1.0 is current in v5. */
export const AGUI_V5_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V5_CURRENT_VERSION = '1.0';
export const AGUI_V5_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v5. */
export const A2UI_V5_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V5_CURRENT_VERSION = '1.0';
export const A2UI_V5_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. */
export const PROTOCOL_V5_CURRENT_VERSIONS: Record<ProtocolV5Family, string> = {
  acp: ACP_V5_CURRENT_VERSION,
  poppy: POPPY_V5_CURRENT_VERSION,
  mcp: MCP_V5_CURRENT_VERSION,
  a2a: A2A_V5_CURRENT_VERSION,
  agui: AGUI_V5_CURRENT_VERSION,
  a2ui: A2UI_V5_CURRENT_VERSION,
};

/** All known versions per family, newest first. */
export const PROTOCOL_V5_VERSION_MATRIX: Record<ProtocolV5Family, readonly string[]> = {
  acp: ACP_V5_VERSIONS,
  poppy: POPPY_V5_VERSIONS,
  mcp: MCP_V5_VERSIONS,
  a2a: A2A_V5_VERSIONS,
  agui: AGUI_V5_VERSIONS,
  a2ui: A2UI_V5_VERSIONS,
};

/** Legacy (supported but deprecated / draft) versions per family. */
export const PROTOCOL_V5_LEGACY_VERSIONS: Record<ProtocolV5Family, readonly string[]> = {
  acp: ACP_V5_LEGACY_VERSIONS,
  poppy: POPPY_V5_DRAFT_VERSIONS,
  mcp: MCP_V5_LEGACY_VERSIONS,
  a2a: A2A_V5_LEGACY_VERSIONS,
  agui: AGUI_V5_LEGACY_VERSIONS,
  a2ui: A2UI_V5_LEGACY_VERSIONS,
};

/** Lifecycle of one protocol version. */
export type ProtocolV5VersionStatus = 'current' | 'legacy' | 'removed' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV5VersionError extends Error {
  readonly family: ProtocolV5Family;
  readonly code: string;
  constructor(family: ProtocolV5Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV5VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` version (ACP / Poppy / A2A / AG-UI / A2UI), or null. */
export function parseProtocolV5Semver(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?(?:-([a-z]+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Parse an MCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseMcpV5DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV5Versions(
  family: ProtocolV5Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp') {
    const na = parseMcpV5DateVersion(a);
    const nb = parseMcpV5DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  // `2.0-draft` sorts below final `2.0` and above `1.0`; same for `1.1-rc`.
  // A draft/RC ranks below its own final version (0 < 1).
  const rank = (v: string): number => {
    if (v.endsWith('-draft') || v.endsWith('-rc')) return 0;
    return 1;
  };
  const pa = parseProtocolV5Semver(a);
  const pb = parseProtocolV5Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV5VersionStatus(
  family: ProtocolV5Family,
  version: string,
): ProtocolV5VersionStatus {
  const matrix = PROTOCOL_V5_VERSION_MATRIX[family];
  if (!matrix.includes(version as never)) return 'unknown';
  if (family === 'a2a' && (A2A_V5_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if (version === PROTOCOL_V5_CURRENT_VERSIONS[family]) return 'current';
  if ((PROTOCOL_V5_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  return 'unknown';
}

/** True when the version is a draft / RC that may change incompatibly. */
export function protocolV5VersionIsUnstable(family: ProtocolV5Family, version: string): boolean {
  if (family === 'acp') return (ACP_V5_DRAFT_VERSIONS as readonly string[]).includes(version);
  if (family === 'poppy') return (POPPY_V5_DRAFT_VERSIONS as readonly string[]).includes(version);
  if (family === 'a2a') return version === '1.1-rc';
  return false;
}

/** One family's negotiation result. */
export interface ProtocolV5Negotiation {
  family: ProtocolV5Family;
  negotiated: string | null;
  status: ProtocolV5VersionStatus;
  /** True when the negotiated version is a draft / RC (may change). */
  unstable: boolean;
  /** Human-readable note for the UI (empty when clean). */
  note: string;
}

/**
 * Negotiate one family's version: pick the highest version both
 * sides speak. `serverVersions` is what the peer offers (newest
 * first); the local matrix is the authority for what is current /
 * legacy / removed. Returns `negotiated: null` when nothing overlaps.
 * A removed version is never picked even when both sides list it.
 */
export function negotiateProtocolV5Version(
  family: ProtocolV5Family,
  serverVersions: readonly string[] | undefined,
): ProtocolV5Negotiation {
  const local = PROTOCOL_V5_VERSION_MATRIX[family];
  const offered = serverVersions ?? [];
  for (const candidate of local) {
    if (!offered.includes(candidate)) continue;
    const status = protocolV5VersionStatus(family, candidate);
    if (status === 'removed') continue;
    const unstable = protocolV5VersionIsUnstable(family, candidate);
    return {
      family,
      negotiated: candidate,
      status,
      unstable,
      note: unstable
        ? `${family} ${candidate} is a draft / release candidate and may change incompatibly.`
        : status === 'legacy'
          ? `${family} ${candidate} is legacy; upgrade to ${PROTOCOL_V5_CURRENT_VERSIONS[family]}.`
          : '',
    };
  }
  return {
    family,
    negotiated: null,
    status: 'unknown',
    unstable: false,
    note: `No common ${family} version (local: ${local.join(', ')}; peer: ${offered.join(', ') || 'none'}).`,
  };
}

/** Negotiate every family at once. */
export function negotiateAllProtocolsV5(
  serverVersions: Partial<Record<ProtocolV5Family, readonly string[]>>,
): Record<ProtocolV5Family, ProtocolV5Negotiation> {
  const out = {} as Record<ProtocolV5Family, ProtocolV5Negotiation>;
  for (const family of PROTOCOL_V5_FAMILIES) {
    out[family] = negotiateProtocolV5Version(family, serverVersions[family]);
  }
  return out;
}

/**
 * Downgrade check: can a v5 client talk to a peer that only speaks
 * the v4 matrix? Returns the families that still negotiate and the
 * ones that lose their current version (ACP is new in v5, so a v4
 * peer has no ACP at all; A2A falls back to `1.1-rc`).
 */
export interface ProtocolV5DowngradeReport {
  family: ProtocolV5Family;
  v5Current: string;
  v4Negotiated: string | null;
  compatible: boolean;
  note: string;
}

export function protocolV5DowngradeToV4(): ProtocolV5DowngradeReport[] {
  const v4Offered: Partial<Record<ProtocolV5Family, readonly string[]>> = {
    poppy: ['1.0', '0.2', '0.1'],
    mcp: ['2026-07-28', '2025-11-25'],
    a2a: ['1.1-rc', '1.0'],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
  };
  return PROTOCOL_V5_FAMILIES.map((family) => {
    const negotiated = negotiateProtocolV5Version(family, v4Offered[family]);
    const compatible = negotiated.negotiated !== null;
    return {
      family,
      v5Current: PROTOCOL_V5_CURRENT_VERSIONS[family],
      v4Negotiated: negotiated.negotiated,
      compatible,
      note:
        family === 'acp'
          ? 'ACP is new in v5; a v4 peer speaks no ACP — ACP features are unavailable, everything else still works.'
          : compatible
            ? `Negotiates ${negotiated.negotiated} with a v4 peer${negotiated.unstable ? ' (draft/RC)' : ''}.`
            : `No common ${family} version with a v4 peer.`,
    };
  });
}

/**
 * Deprecation calendar for the v5 surface — one row per family, so
 * the UI can say what is current, what is legacy-but-supported and
 * what is removed, and when the legacy surface leaves.
 */
export interface ProtocolV5DeprecationRow {
  family: ProtocolV5Family;
  current: string;
  legacy: readonly string[];
  removed: readonly string[];
  removalDate: string;
  note: string;
}

export function protocolV5DeprecationCalendar(): ProtocolV5DeprecationRow[] {
  return [
    {
      family: 'acp',
      current: ACP_V5_CURRENT_VERSION,
      legacy: ACP_V5_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: 'ACP v2 is a draft under the Linux Foundation (merged with A2A); it may change incompatibly before final.',
    },
    {
      family: 'poppy',
      current: POPPY_V5_CURRENT_VERSION,
      legacy: POPPY_V5_DRAFT_VERSIONS,
      removed: [],
      removalDate: '',
      note: 'Draft 0.1/0.2 may change incompatibly before 1.0 is final.',
    },
    {
      family: 'mcp',
      current: MCP_V5_CURRENT_VERSION,
      legacy: MCP_V5_LEGACY_VERSIONS,
      removed: [],
      removalDate: MCP_V5_LEGACY_REMOVAL_DATE,
      note: `Sampling / roots / logging deprecated (SEP-2577); earliest removal ${MCP_V5_DEPRECATED_REMOVAL_FLOOR}.`,
    },
    {
      family: 'a2a',
      current: A2A_V5_CURRENT_VERSION,
      legacy: A2A_V5_LEGACY_VERSIONS,
      removed: A2A_V5_REMOVED_VERSIONS,
      removalDate: '',
      note: `1.1 is final (${A2A_V5_GOVERNANCE}); 1.1-rc stays compatible; stable is no longer 1.0.`,
    },
    {
      family: 'agui',
      current: AGUI_V5_CURRENT_VERSION,
      legacy: AGUI_V5_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '1.0 freezes 31 event types; THINKING_* removed, use REASONING_*.',
    },
    {
      family: 'a2ui',
      current: A2UI_V5_CURRENT_VERSION,
      legacy: A2UI_V5_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '',
    },
  ];
}

/** One-line summary of the v5 matrix, for logs and the UI. */
export function protocolV5MatrixSummary(): string {
  return PROTOCOL_V5_FAMILIES.map(
    (f) => `${f} ${PROTOCOL_V5_CURRENT_VERSIONS[f]}`,
  ).join(' · ');
}
