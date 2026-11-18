/**
 * Protocols v4 — version matrix + unified negotiation (v1.20, Team T2).
 *
 * Idea only, learned from the public protocol descriptions researched
 * for this wave (see docs/protocols-v120.md):
 *  - Personal Agent Protocol 1.0 "Poppy" (Sierra, with Meta):
 *    draft 0.1 published 9 Oct 2026 at personalagentprotocol.org,
 *    draft 0.2 in progress; a 1.0 release was reported 13 Nov 2026.
 *    The wire shapes below target the draft 0.1/0.2 track that 1.0
 *    keeps: `/.well-known/poppy.json` discovery, agent `client_id`
 *    URL metadata, opaque per-company user ids, signed-assertion
 *    sessions, `poppy:read` / `poppy:write` scopes, direct / device /
 *    mediated sign-in, routes over website / OpenAPI / MCP /
 *    conversation with the company's agent.
 *  - A2A v1.1 RC (tagged 29 Oct 2026): `SendLiveMessage` two-way
 *    streaming while a task runs, client-written artifacts, media
 *    type `application/a2a-agent-card+json`. Stable is still 1.0.1.
 *  - MCP 2026-07-28 (SEP-2577): sampling, roots and logging are
 *    deprecated; earliest removal is the first revision released on
 *    or after 2027-07-28. Elicitation is NOT deprecated — it moves
 *    onto Multi Round-Trip Requests (SEP-2322).
 *  - AG-UI 1.0 (spec/1.0/schema.json): 31 event types, frozen set;
 *    the old `THINKING_*` events are gone, replaced by `REASONING_*`.
 *  - IETF Agent Communication Protocols WG (agentproto), chartered
 *    Oct 2026 (chairs Orie Steele, Leslie Daigle): a common baseline
 *    agentic dialog management protocol + reference architecture;
 *    it neither replaces application-layer protocols (MCP/A2A) nor
 *    defines a new transport. Milestones: use cases Dec 2026,
 *    architecture Feb 2027, dialog-management draft Mar 2027,
 *    to IESG Mar 2028. Sibling WG DAWN (discovery) chartered
 *    22 Oct 2026.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the v3 matrix (`protocolsV3/versions.ts`) without
 * touching it: v3 pins MCP 2026-07-28 / A2A 1.1 / AG-UI 1.0 / A2UI 1.0
 * as current. v4 adds the Poppy family, records the A2A 1.1 RC
 * status (stable is still 1.0.1 — 1.1 is a release candidate, so
 * `SendLiveMessage` is negotiated as an opt-in capability, never
 * assumed), records the MCP sampling/roots/logging removal floor,
 * and adds the IETF watch-track (not a wire protocol yet, so it is
 * a readiness family, not a negotiable version).
 *
 * Version rules (v4):
 * - poppy: `1.0` is current; `0.2` / `0.1` are draft (supported,
 *   treated as pre-1.0, with a warning that any part may change).
 * - a2a: `1.1-rc` is the RC track (current for live streaming);
 *   `1.1` (final, when it lands) supersedes it; `1.0` is stable
 *   legacy; `0.3`/`0.2` are removed.
 * - mcp: `2026-07-28` is current; legacy versions leave the
 *   default surface on 2027-07-28 (same floor as the sampling /
 *   roots / logging removal).
 * - agui: `1.0` is current; `0.0.1` is legacy.
 * - a2ui: `1.0` is current; `0.1` is legacy.
 */

export const PROTOCOL_V4_FAMILIES = ['poppy', 'mcp', 'a2a', 'agui', 'a2ui'] as const;
export type ProtocolV4Family = (typeof PROTOCOL_V4_FAMILIES)[number];

/** Poppy versions open-bot speaks. */
export const POPPY_V4_VERSIONS = ['1.0', '0.2', '0.1'] as const;
export const POPPY_V4_CURRENT_VERSION = '1.0';
export const POPPY_V4_DRAFT_VERSIONS = ['0.2', '0.1'] as const;
/** Poppy discovery document path (spec: served over HTTPS). */
export const POPPY_V4_DISCOVERY_PATH = '/.well-known/poppy.json';
/** Poppy scopes (spec draft 0.1). */
export const POPPY_V4_SCOPES = ['poppy:read', 'poppy:write'] as const;
export type PoppyV4Scope = (typeof POPPY_V4_SCOPES)[number];

/** MCP core version (spec 2026-07-28). */
export const MCP_V4_CURRENT_VERSION = '2026-07-28';
export const MCP_V4_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V4_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V4_LEGACY_REMOVAL_DATE = '2027-07-28';
/**
 * Earliest removal of deprecated MCP features (sampling, roots,
 * logging) per SEP-2577 / the deprecated-features registry: the
 * first revision released on or after this date.
 */
export const MCP_V4_DEPRECATED_REMOVAL_FLOOR = '2027-07-28';

/** A2A versions: 1.1 is still an RC (tagged 29 Oct 2026). */
export const A2A_V4_VERSIONS = ['1.1', '1.1-rc', '1.0', '0.3', '0.2'] as const;
export const A2A_V4_CURRENT_VERSION = '1.1-rc';
export const A2A_V4_STABLE_VERSION = '1.0';
export const A2A_V4_LEGACY_VERSIONS = ['1.0'] as const;
export const A2A_V4_REMOVED_VERSIONS = ['0.3', '0.2'] as const;
/** Media type for an A2A Agent Card (v1.1). */
export const A2A_V4_AGENT_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
/** JSON-RPC method for A2A v1.1 two-way streaming. */
export const A2A_V4_SEND_LIVE_MESSAGE_METHOD = 'message/sendLive';

/** AG-UI 1.0 is current in v4. */
export const AGUI_V4_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V4_CURRENT_VERSION = '1.0';
export const AGUI_V4_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v4. */
export const A2UI_V4_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V4_CURRENT_VERSION = '1.0';
export const A2UI_V4_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. */
export const PROTOCOL_V4_CURRENT_VERSIONS: Record<ProtocolV4Family, string> = {
  poppy: POPPY_V4_CURRENT_VERSION,
  mcp: MCP_V4_CURRENT_VERSION,
  a2a: A2A_V4_CURRENT_VERSION,
  agui: AGUI_V4_CURRENT_VERSION,
  a2ui: A2UI_V4_CURRENT_VERSION,
};

/** All known versions per family, newest first. */
export const PROTOCOL_V4_VERSION_MATRIX: Record<ProtocolV4Family, readonly string[]> = {
  poppy: POPPY_V4_VERSIONS,
  mcp: MCP_V4_VERSIONS,
  a2a: A2A_V4_VERSIONS,
  agui: AGUI_V4_VERSIONS,
  a2ui: A2UI_V4_VERSIONS,
};

/** Legacy (supported but deprecated) versions per family. */
export const PROTOCOL_V4_LEGACY_VERSIONS: Record<ProtocolV4Family, readonly string[]> = {
  poppy: POPPY_V4_DRAFT_VERSIONS,
  mcp: MCP_V4_LEGACY_VERSIONS,
  a2a: A2A_V4_LEGACY_VERSIONS,
  agui: AGUI_V4_LEGACY_VERSIONS,
  a2ui: A2UI_V4_LEGACY_VERSIONS,
};

/** Lifecycle of one protocol version. */
export type ProtocolV4VersionStatus = 'current' | 'legacy' | 'removed' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV4VersionError extends Error {
  readonly family: ProtocolV4Family;
  readonly code: string;
  constructor(family: ProtocolV4Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV4VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` version (Poppy / A2A / AG-UI / A2UI), or null. */
export function parseProtocolV4Semver(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?(?:-([a-z]+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Parse an MCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseMcpV4DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV4Versions(
  family: ProtocolV4Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp') {
    const na = parseMcpV4DateVersion(a);
    const nb = parseMcpV4DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  // A2A `1.1-rc` sorts below final `1.1` and above `1.0`.
  if (family === 'a2a') {
    if (a === '1.1-rc' && b === '1.1') return -1;
    if (a === '1.1' && b === '1.1-rc') return 1;
  }
  const pa = parseProtocolV4Semver(a);
  const pb = parseProtocolV4Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV4VersionStatus(
  family: ProtocolV4Family,
  version: string,
): ProtocolV4VersionStatus {
  const matrix = PROTOCOL_V4_VERSION_MATRIX[family];
  if (!matrix.includes(version as never)) return 'unknown';
  if (family === 'a2a' && (A2A_V4_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if (version === PROTOCOL_V4_CURRENT_VERSIONS[family]) return 'current';
  if ((PROTOCOL_V4_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  // A2A `1.1` (final) is not current yet — it is the upcoming stable.
  if (family === 'a2a' && version === '1.1') return 'current';
  return 'unknown';
}

/** One family's negotiation result. */
export interface ProtocolV4Negotiation {
  family: ProtocolV4Family;
  negotiated: string | null;
  status: ProtocolV4VersionStatus;
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
 */
export function negotiateProtocolV4Version(
  family: ProtocolV4Family,
  serverVersions: readonly string[] | undefined,
): ProtocolV4Negotiation {
  const local = PROTOCOL_V4_VERSION_MATRIX[family];
  const offered = serverVersions ?? [];
  for (const candidate of local) {
    if (!offered.includes(candidate)) continue;
    const status = protocolV4VersionStatus(family, candidate);
    if (status === 'removed') continue;
    const unstable =
      (family === 'poppy' && (POPPY_V4_DRAFT_VERSIONS as readonly string[]).includes(candidate)) ||
      (family === 'a2a' && candidate === '1.1-rc');
    return {
      family,
      negotiated: candidate,
      status,
      unstable,
      note: unstable
        ? `${family} ${candidate} is a draft / release candidate and may change incompatibly.`
        : status === 'legacy'
          ? `${family} ${candidate} is legacy; upgrade to ${PROTOCOL_V4_CURRENT_VERSIONS[family]}.`
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
export function negotiateAllProtocolsV4(
  serverVersions: Partial<Record<ProtocolV4Family, readonly string[]>>,
): Record<ProtocolV4Family, ProtocolV4Negotiation> {
  const out = {} as Record<ProtocolV4Family, ProtocolV4Negotiation>;
  for (const family of PROTOCOL_V4_FAMILIES) {
    out[family] = negotiateProtocolV4Version(family, serverVersions[family]);
  }
  return out;
}

/**
 * Deprecation calendar for the v4 surface — one row per family, so
 * the UI can say what is current, what is legacy-but-supported and
 * what is removed, and when the legacy surface leaves.
 */
export interface ProtocolV4DeprecationRow {
  family: ProtocolV4Family;
  current: string;
  legacy: readonly string[];
  removed: readonly string[];
  removalDate: string;
  note: string;
}

export function protocolV4DeprecationCalendar(): ProtocolV4DeprecationRow[] {
  return [
    {
      family: 'poppy',
      current: POPPY_V4_CURRENT_VERSION,
      legacy: POPPY_V4_DRAFT_VERSIONS,
      removed: [],
      removalDate: '',
      note: 'Draft 0.1/0.2 may change incompatibly before 1.0 is final.',
    },
    {
      family: 'mcp',
      current: MCP_V4_CURRENT_VERSION,
      legacy: MCP_V4_LEGACY_VERSIONS,
      removed: [],
      removalDate: MCP_V4_LEGACY_REMOVAL_DATE,
      note: `Sampling / roots / logging deprecated (SEP-2577); earliest removal ${MCP_V4_DEPRECATED_REMOVAL_FLOOR}.`,
    },
    {
      family: 'a2a',
      current: A2A_V4_CURRENT_VERSION,
      legacy: A2A_V4_LEGACY_VERSIONS,
      removed: A2A_V4_REMOVED_VERSIONS,
      removalDate: '',
      note: '1.1 is an RC (SendLiveMessage); stable is 1.0.1. Live streaming is opt-in.',
    },
    {
      family: 'agui',
      current: AGUI_V4_CURRENT_VERSION,
      legacy: AGUI_V4_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '1.0 freezes 31 event types; THINKING_* removed, use REASONING_*.',
    },
    {
      family: 'a2ui',
      current: A2UI_V4_CURRENT_VERSION,
      legacy: A2UI_V4_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '',
    },
  ];
}
