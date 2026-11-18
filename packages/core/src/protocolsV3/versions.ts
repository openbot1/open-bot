/**
 * Protocols v3 — version matrix + unified negotiation (v1.19, Team T3).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v119.md section 2 (MCP spec 2026-07-28, A2A v1.1,
 * AG-UI 1.0, A2UI, Agent Skills joining the Agentic AI Foundation).
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the v2 matrix (`protocolsV2/versions.ts`) without
 * touching it: v2 pins MCP 2026-07-28 / A2A 1.0 / AG-UI 1.0 / A2UI 1.0
 * as current. v3 moves A2A to 1.1 (two-way streaming is now final,
 * not RC), records the MCP extension identifiers that the stateless
 * core splits out (Tasks / MCP Apps / Skills-over-MCP), and adds a
 * single `negotiateAllProtocolsV3` entry point plus a deprecation
 * calendar so the UI can say, per family, what is current, what is
 * legacy-but-supported, and what is removed.
 *
 * Version rules (v3):
 * - MCP: `2026-07-28` is current; every `2025-*` / `2024-11-05`
 *   version is legacy (supported through the compat shim, removed
 *   from the default surface on 2027-07-28).
 * - A2A: `1.1` is current; `1.0` is legacy (supported); `0.2`/`0.3`
 *   are removed (a card that old is rejected with a clear error).
 * - AG-UI: `1.0` is current; `0.0.1` is legacy.
 * - A2UI: `1.0` is current; `0.1` is legacy.
 * - Extensions are negotiated separately from the core version:
 *   a server may speak MCP 2026-07-28 core without any extension,
 *   and a client must not assume Tasks/Apps/Skills exist from the
 *   core version alone.
 */

export const PROTOCOL_V3_FAMILIES = ['mcp', 'a2a', 'agui', 'a2ui'] as const;
export type ProtocolV3Family = (typeof PROTOCOL_V3_FAMILIES)[number];

/** MCP core version (spec 2026-07-28). */
export const MCP_V3_CURRENT_VERSION = '2026-07-28';
export const MCP_V3_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V3_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V3_LEGACY_REMOVAL_DATE = '2027-07-28';

/** A2A v1.1 is current in v3 (two-way streaming final). */
export const A2A_V3_VERSIONS = ['1.1', '1.0', '0.3', '0.2'] as const;
export const A2A_V3_CURRENT_VERSION = '1.1';
export const A2A_V3_LEGACY_VERSIONS = ['1.0'] as const;
export const A2A_V3_REMOVED_VERSIONS = ['0.3', '0.2'] as const;

/** AG-UI 1.0 is current in v3. */
export const AGUI_V3_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V3_CURRENT_VERSION = '1.0';
export const AGUI_V3_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v3. */
export const A2UI_V3_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V3_CURRENT_VERSION = '1.0';
export const A2UI_V3_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. */
export const PROTOCOL_V3_CURRENT_VERSIONS: Record<ProtocolV3Family, string> = {
  mcp: MCP_V3_CURRENT_VERSION,
  a2a: A2A_V3_CURRENT_VERSION,
  agui: AGUI_V3_CURRENT_VERSION,
  a2ui: A2UI_V3_CURRENT_VERSION,
};

/** All known versions per family, newest first. */
export const PROTOCOL_V3_VERSION_MATRIX: Record<ProtocolV3Family, readonly string[]> = {
  mcp: MCP_V3_VERSIONS,
  a2a: A2A_V3_VERSIONS,
  agui: AGUI_V3_VERSIONS,
  a2ui: A2UI_V3_VERSIONS,
};

/** Legacy (supported but deprecated) versions per family. */
export const PROTOCOL_V3_LEGACY_VERSIONS: Record<ProtocolV3Family, readonly string[]> = {
  mcp: MCP_V3_LEGACY_VERSIONS,
  a2a: A2A_V3_LEGACY_VERSIONS,
  agui: AGUI_V3_LEGACY_VERSIONS,
  a2ui: A2UI_V3_LEGACY_VERSIONS,
};

/**
 * MCP 2026-07-28 extension identifiers. The stateless core splits
 * Tasks / MCP Apps / Skills-over-MCP out of the core: each is an
 * extension negotiated through capabilities, never assumed.
 */
export const MCP_V3_EXTENSION_IDS = {
  tasks: 'io.modelcontextprotocol/tasks',
  apps: 'io.modelcontextprotocol/apps',
  skills: 'io.modelcontextprotocol/skills',
  elicitation: 'io.modelcontextprotocol/elicitation',
} as const;
export type McpV3ExtensionId =
  (typeof MCP_V3_EXTENSION_IDS)[keyof typeof MCP_V3_EXTENSION_IDS];
export const MCP_V3_EXTENSION_ID_LIST: readonly string[] = [
  MCP_V3_EXTENSION_IDS.tasks,
  MCP_V3_EXTENSION_IDS.apps,
  MCP_V3_EXTENSION_IDS.skills,
  MCP_V3_EXTENSION_IDS.elicitation,
];

/** Extension id -> human-readable short name (UI only). */
export const MCP_V3_EXTENSION_LABELS: Record<string, string> = {
  [MCP_V3_EXTENSION_IDS.tasks]: 'Tasks',
  [MCP_V3_EXTENSION_IDS.apps]: 'MCP Apps',
  [MCP_V3_EXTENSION_IDS.skills]: 'Skills over MCP',
  [MCP_V3_EXTENSION_IDS.elicitation]: 'Elicitation',
};

/** Lifecycle of one protocol version. */
export type ProtocolV3VersionStatus = 'current' | 'legacy' | 'removed' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV3VersionError extends Error {
  readonly family: ProtocolV3Family;
  readonly code: string;
  constructor(family: ProtocolV3Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV3VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` (A2A/AG-UI/A2UI) version, or null. */
export function parseProtocolV3Semver(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Parse an MCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseMcpV3DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV3Versions(
  family: ProtocolV3Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp') {
    const na = parseMcpV3DateVersion(a);
    const nb = parseMcpV3DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  const pa = parseProtocolV3Semver(a);
  const pb = parseProtocolV3Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV3VersionStatus(
  family: ProtocolV3Family,
  version: string,
): ProtocolV3VersionStatus {
  if (version === PROTOCOL_V3_CURRENT_VERSIONS[family]) return 'current';
  if (family === 'a2a' && (A2A_V3_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if ((PROTOCOL_V3_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  if ((PROTOCOL_V3_VERSION_MATRIX[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  return 'unknown';
}

/** True when the version is one this build speaks (current or legacy). */
export function isSupportedProtocolV3Version(family: ProtocolV3Family, version: string): boolean {
  const status = protocolV3VersionStatus(family, version);
  return status === 'current' || status === 'legacy';
}

/** True when the version is legacy (supported, but the UI should warn). */
export function isLegacyProtocolV3Version(family: ProtocolV3Family, version: string): boolean {
  return protocolV3VersionStatus(family, version) === 'legacy';
}

/** Days from `from` until the legacy MCP surface is removed. */
export function mcpV3LegacyRemovalInDays(from: Date = new Date()): number {
  const removal = new Date(`${MCP_V3_LEGACY_REMOVAL_DATE}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.ceil((removal - from.getTime()) / 86_400_000));
}

/** One family's negotiation outcome. */
export interface ProtocolV3Negotiation {
  family: ProtocolV3Family;
  /** Version both sides agreed on (null when nothing overlaps). */
  version: string | null;
  status: ProtocolV3VersionStatus;
  /** Versions the client offered. */
  offered: string[];
  /** Versions the server listed. */
  serverVersions: string[];
}

/**
 * Negotiate one family: pick the newest version both sides list.
 * Returns `version: null` + status `unknown` when there is no overlap
 * (the caller decides whether to fail or to fall back to its default).
 * Never throws.
 */
export function negotiateProtocolV3Version(
  family: ProtocolV3Family,
  clientOffered: readonly string[],
  serverOffered: readonly string[] | undefined,
): ProtocolV3Negotiation {
  const offered = [...clientOffered];
  const serverVersions = [...(serverOffered ?? [])];
  const serverSet = new Set(serverVersions);
  for (const candidate of offered) {
    if (serverSet.has(candidate) && isSupportedProtocolV3Version(family, candidate)) {
      return {
        family,
        version: candidate,
        status: protocolV3VersionStatus(family, candidate),
        offered,
        serverVersions,
      };
    }
  }
  // No overlap: if the server listed nothing at all, the client may
  // still speak its newest offered version (pre-discovery servers).
  if (serverVersions.length === 0 && offered.length > 0) {
    const fallback = offered[0];
    return {
      family,
      version: fallback,
      status: protocolV3VersionStatus(family, fallback),
      offered,
      serverVersions,
    };
  }
  return { family, version: null, status: 'unknown', offered, serverVersions };
}

/** Like `negotiateProtocolV3Version`, but throws on no overlap. */
export function negotiateProtocolV3VersionOrThrow(
  family: ProtocolV3Family,
  clientOffered: readonly string[],
  serverOffered: readonly string[] | undefined,
): ProtocolV3Negotiation {
  const result = negotiateProtocolV3Version(family, clientOffered, serverOffered);
  if (result.version === null) {
    throw new ProtocolV3VersionError(
      family,
      'NO_COMMON_VERSION',
      `No common ${family} version: client offers [${clientOffered.join(', ')}], ` +
        `server offers [${(serverOffered ?? []).join(', ')}]`,
    );
  }
  return result;
}

/** Negotiate every family at once (client offers its current first). */
export function negotiateAllProtocolsV3(
  serverVersions: Partial<Record<ProtocolV3Family, readonly string[]>>,
): Record<ProtocolV3Family, ProtocolV3Negotiation> {
  const out = {} as Record<ProtocolV3Family, ProtocolV3Negotiation>;
  for (const family of PROTOCOL_V3_FAMILIES) {
    out[family] = negotiateProtocolV3Version(
      family,
      PROTOCOL_V3_VERSION_MATRIX[family],
      serverVersions[family],
    );
  }
  return out;
}

/** Known capability names per family (for UI + capability matching). */
export const PROTOCOL_V3_KNOWN_CAPABILITIES: Record<ProtocolV3Family, readonly string[]> = {
  mcp: [
    'tools',
    'resources',
    'prompts',
    'tasks',
    'apps',
    'skills',
    'elicitation',
    'multiRoundTrip',
    'streamableHttp',
    'stateless',
  ],
  a2a: ['tasks', 'streaming', 'twoWayStreaming', 'pushNotifications', 'artifacts', 'signedCards'],
  agui: ['events', 'interrupts', 'subagents', 'generativeUi', 'stateSnapshots', 'resume'],
  a2ui: ['components', 'surfaces', 'actions', 'dataBinding', 'layouts', 'fallback'],
};

/** Capability match between what a client needs and a server offers. */
export interface ProtocolV3CapabilityMatch {
  matched: string[];
  missing: string[];
  extra: string[];
}

/** Split a capability list into matched / missing / extra. */
export function matchCapabilitiesV3(
  needed: readonly string[],
  offered: readonly string[],
): ProtocolV3CapabilityMatch {
  const offeredSet = new Set(offered);
  const neededSet = new Set(needed);
  return {
    matched: needed.filter((c) => offeredSet.has(c)),
    missing: needed.filter((c) => !offeredSet.has(c)),
    extra: offered.filter((c) => !neededSet.has(c)),
  };
}

/** True when an extension id is one the v3 core knows. */
export function isKnownMcpV3Extension(id: string): boolean {
  return (MCP_V3_EXTENSION_ID_LIST as readonly string[]).includes(id);
}

/** Short label for an extension id (falls back to the id itself). */
export function mcpV3ExtensionLabel(id: string): string {
  return MCP_V3_EXTENSION_LABELS[id] ?? id;
}
