/**
 * Protocols v2 — version matrix + negotiation (v1.16, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v116.md sections 3 and 7: MCP 2026-07-28 is a
 * stateless core (no `initialize`, no `Mcp-Session-Id`), A2A v1.0
 * adds signed Agent Cards + version negotiation + multi-tenancy,
 * AG-UI 1.0 and A2UI 1.0 are versioned streams/surfaces. No code,
 * text or asset from any other repo is copied here — the version
 * strings below are the public protocol identifiers themselves,
 * and everything else is open-bot's own design, written from the
 * protocol idea.
 *
 * This module is the single source of truth for which protocol
 * versions open-bot v2 speaks, how two version lists are
 * reconciled, and what error (with fallback guidance) a client
 * gets when no version matches. It builds on the v1.15 triad
 * (`protocols/`) without touching it: v1.15 knows one MCP
 * version (`2026-07-28`) and one A2A version; v2 knows the full
 * matrix, including the 2025-era versions a compat shim must
 * still accept until the deprecation date.
 *
 * Design rules:
 * - Versions are plain strings; comparison is semantic for
 *   `major.minor[.patch]` and chronological for MCP dates
 *   (`YYYY-MM-DD`). Never compare them as raw strings.
 * - Negotiation always prefers the highest version both sides
 *   support. When nothing matches, the error names the closest
 *   version on each side and tells the caller exactly how to
 *   fall back — an error without a fallback is a dead end.
 * - The deprecation window is data, not a comment: 2025-era MCP
 *   versions are supported until `MCP_V2_LEGACY_REMOVAL_DATE`
 *   (28/07/2027, the earliest removal date in the survey) and
 *   the shim reports how many days are left.
 */

/** Protocol families v2 negotiates. */
export const PROTOCOL_V2_FAMILIES = ['mcp', 'a2a', 'agui', 'a2ui'] as const;
export type ProtocolV2Family = (typeof PROTOCOL_V2_FAMILIES)[number];

/** MCP protocol versions, oldest first. The 2025-era entries are legacy. */
export const MCP_V2_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2026-07-28',
] as const;
/** MCP versions that still need `initialize` + a session id. */
export const MCP_V2_LEGACY_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const;
/** The current MCP core version: stateless, `server/discover` mandatory. */
export const MCP_V2_CURRENT_VERSION = '2026-07-28';
/** Earliest date the legacy MCP versions may be removed (survey §3). */
export const MCP_V2_LEGACY_REMOVAL_DATE = '2027-07-28';

/** A2A protocol versions, oldest first. */
export const A2A_V2_VERSIONS = ['0.2.0', '0.3.0', '1.0.0'] as const;
export const A2A_V2_CURRENT_VERSION = '1.0.0';
/** A2A versions before signed cards existed (unsigned cards only). */
export const A2A_V2_UNSIGNED_VERSIONS = ['0.2.0', '0.3.0'] as const;

/** AG-UI stream versions, oldest first. */
export const AGUI_V2_VERSIONS = ['0.0.1', '1.0.0'] as const;
export const AGUI_V2_CURRENT_VERSION = '1.0.0';

/** A2UI generative-UI versions, oldest first. */
export const A2UI_V2_VERSIONS = ['0.1.0', '1.0.0'] as const;
export const A2UI_V2_CURRENT_VERSION = '1.0.0';

/** Supported versions per family, oldest first. */
export const PROTOCOL_V2_VERSION_MATRIX: Record<ProtocolV2Family, readonly string[]> = {
  mcp: MCP_V2_VERSIONS,
  a2a: A2A_V2_VERSIONS,
  agui: AGUI_V2_VERSIONS,
  a2ui: A2UI_V2_VERSIONS,
};

/** Current (preferred) version per family. */
export const PROTOCOL_V2_CURRENT_VERSIONS: Record<ProtocolV2Family, string> = {
  mcp: MCP_V2_CURRENT_VERSION,
  a2a: A2A_V2_CURRENT_VERSION,
  agui: AGUI_V2_CURRENT_VERSION,
  a2ui: A2UI_V2_CURRENT_VERSION,
};

/** Result of a version negotiation. */
export interface ProtocolV2Negotiation {
  family: ProtocolV2Family;
  /** Highest version both sides support, or null when there is none. */
  agreed: string | null;
  /** Versions the client offered (deduped, in the order offered). */
  clientVersions: string[];
  /** Versions the server supports (deduped, in the order listed). */
  serverVersions: string[];
  /** True when the agreed version is the newest either side offers. */
  isLatest: boolean;
  /** True when the agreed version is a legacy (deprecated) version. */
  isLegacy: boolean;
  /** Days until the agreed legacy version may be removed, or null. */
  legacyRemovalInDays: number | null;
  /** Human-readable fallback guidance when nothing was agreed. */
  fallbackGuidance: string | null;
}

/** Error raised when no common protocol version exists. */
export class UnsupportedProtocolVersionError extends Error {
  readonly family: ProtocolV2Family;
  readonly clientVersions: string[];
  readonly serverVersions: string[];
  readonly fallbackGuidance: string;
  readonly code = 'UNSUPPORTED_PROTOCOL_VERSION';
  constructor(family: ProtocolV2Family, clientVersions: string[], serverVersions: string[], fallbackGuidance: string) {
    super(
      `No common ${family} protocol version: client offers [${clientVersions.join(', ')}], ` +
        `server supports [${serverVersions.join(', ')}]. ${fallbackGuidance}`,
    );
    this.name = 'UnsupportedProtocolVersionError';
    this.family = family;
    this.clientVersions = clientVersions;
    this.serverVersions = serverVersions;
    this.fallbackGuidance = fallbackGuidance;
  }
}

function dedupe(versions: readonly string[]): string[] {
  return [...new Set(versions.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/** Parse a `major.minor[.patch]` version into numbers, or null when malformed. */
export function parseProtocolV2Semver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Parse an MCP date version (`YYYY-MM-DD`) into a comparable number, or null. */
export function parseMcpDateVersion(version: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Number(match[1]) * 10000 + month * 100 + day;
}

/**
 * Compare two versions of the same family: -1 / 0 / 1.
 * MCP uses date ordering, every other family uses semver.
 * Unknown shapes sort below known ones so a typo never wins.
 */
export function compareProtocolVersions(family: ProtocolV2Family, a: string, b: string): number {
  if (a === b) return 0;
  if (family === 'mcp') {
    const da = parseMcpDateVersion(a);
    const db = parseMcpDateVersion(b);
    if (da === null && db === null) return a < b ? -1 : 1;
    if (da === null) return -1;
    if (db === null) return 1;
    return da < db ? -1 : 1;
  }
  const sa = parseProtocolV2Semver(a);
  const sb = parseProtocolV2Semver(b);
  if (sa === null && sb === null) return a < b ? -1 : 1;
  if (sa === null) return -1;
  if (sb === null) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` is a known version of `family`. */
export function isSupportedProtocolVersion(family: ProtocolV2Family, version: string): boolean {
  return (PROTOCOL_V2_VERSION_MATRIX[family] as readonly string[]).includes(version);
}

/** True when `version` is a legacy (deprecated but still accepted) version. */
export function isLegacyProtocolV2Version(family: ProtocolV2Family, version: string): boolean {
  if (family === 'mcp') return (MCP_V2_LEGACY_VERSIONS as readonly string[]).includes(version);
  if (family === 'a2a') return (A2A_V2_UNSIGNED_VERSIONS as readonly string[]).includes(version);
  if (family === 'agui') return version === '0.0.1';
  return version === '0.1.0';
}

/** Whole days from `from` (default now) until the legacy removal date. */
export function legacyRemovalInDays(from: Date = new Date()): number {
  const removal = new Date(`${MCP_V2_LEGACY_REMOVAL_DATE}T00:00:00Z`).getTime();
  return Math.max(0, Math.ceil((removal - from.getTime()) / 86_400_000));
}

function buildFallbackGuidance(
  family: ProtocolV2Family,
  clientVersions: string[],
  serverVersions: string[],
): string {
  const serverNewest = [...serverVersions].sort((a, b) => compareProtocolVersions(family, b, a))[0];
  const clientNewest = [...clientVersions].sort((a, b) => compareProtocolVersions(family, b, a))[0];
  if (family === 'mcp') {
    return (
      `Upgrade the ${clientNewest ? 'client' : 'server'} to MCP ${MCP_V2_CURRENT_VERSION} (stateless core, ` +
      `server/discover) or downgrade the ${serverNewest ? 'server' : 'client'} to a version the other side speaks ` +
      `(client newest: ${clientNewest ?? 'none'}; server newest: ${serverNewest ?? 'none'}). ` +
      `Legacy versions ${MCP_V2_LEGACY_VERSIONS.join(', ')} are still accepted until ${MCP_V2_LEGACY_REMOVAL_DATE} ` +
      `through the 2025-era compat shim, but they require initialize + Mcp-Session-Id.`
    );
  }
  if (family === 'a2a') {
    return (
      `Upgrade the older side to A2A ${A2A_V2_CURRENT_VERSION} (signed Agent Cards) or downgrade the newer side ` +
      `to a version both sides speak (client newest: ${clientNewest ?? 'none'}; server newest: ${serverNewest ?? 'none'}). ` +
      `Cards signed for ${A2A_V2_CURRENT_VERSION} are not valid for ${A2A_V2_UNSIGNED_VERSIONS.join(' / ')} — ` +
      `re-issue the card unsigned for those versions.`
    );
  }
  return (
    `Upgrade the older side to ${family.toUpperCase()} ${PROTOCOL_V2_CURRENT_VERSIONS[family]} or downgrade the ` +
    `newer side to a version both sides speak (client newest: ${clientNewest ?? 'none'}; ` +
    `server newest: ${serverNewest ?? 'none'}).`
  );
}

/**
 * Negotiate one protocol family: return the highest version both
 * sides support, or a negotiation with `agreed: null` plus
 * fallback guidance when there is no overlap.
 */
export function negotiateProtocolV2Version(
  family: ProtocolV2Family,
  clientVersions: readonly string[],
  serverVersions: readonly string[] = PROTOCOL_V2_VERSION_MATRIX[family],
): ProtocolV2Negotiation {
  const client = dedupe(clientVersions);
  const server = dedupe(serverVersions);
  const common = client.filter((v) => server.includes(v));
  common.sort((a, b) => compareProtocolVersions(family, b, a));
  const agreed = common[0] ?? null;
  const newestEitherSide = [...client, ...server].sort((a, b) => compareProtocolVersions(family, b, a))[0];
  const legacy = agreed !== null && isLegacyProtocolV2Version(family, agreed);
  return {
    family,
    agreed,
    clientVersions: client,
    serverVersions: server,
    isLatest: agreed !== null && agreed === newestEitherSide,
    isLegacy: legacy,
    legacyRemovalInDays:
      legacy && family === 'mcp' ? legacyRemovalInDays() : null,
    fallbackGuidance:
      agreed === null ? buildFallbackGuidance(family, client, server) : null,
  };
}

/**
 * Negotiate, throwing `UnsupportedProtocolVersionError` (which
 * carries the fallback guidance) when there is no common version.
 */
export function negotiateProtocolV2VersionOrThrow(
  family: ProtocolV2Family,
  clientVersions: readonly string[],
  serverVersions: readonly string[] = PROTOCOL_V2_VERSION_MATRIX[family],
): ProtocolV2Negotiation {
  const result = negotiateProtocolV2Version(family, clientVersions, serverVersions);
  if (result.agreed === null) {
    throw new UnsupportedProtocolVersionError(
      family,
      result.clientVersions,
      result.serverVersions,
      result.fallbackGuidance ?? 'No fallback available.',
    );
  }
  return result;
}

/**
 * Negotiate every family at once (a client handshake offers one
 * version list per family). Families with no overlap are reported
 * in `failed` instead of throwing, so the caller can still use
 * the families that did agree.
 */
export function negotiateAllProtocols(
  offers: Partial<Record<ProtocolV2Family, readonly string[]>>,
): { agreed: Partial<Record<ProtocolV2Family, ProtocolV2Negotiation>>; failed: ProtocolV2Negotiation[] } {
  const agreed: Partial<Record<ProtocolV2Family, ProtocolV2Negotiation>> = {};
  const failed: ProtocolV2Negotiation[] = [];
  for (const family of PROTOCOL_V2_FAMILIES) {
    const offered = offers[family];
    if (!offered || offered.length === 0) continue;
    const result = negotiateProtocolV2Version(family, offered);
    if (result.agreed === null) failed.push(result);
    else agreed[family] = result;
  }
  return { agreed, failed };
}

/** One capability entry: name + whether it is required to proceed. */
export interface ProtocolV2Capability {
  name: string;
  required: boolean;
}

/**
 * Match client capabilities against server capabilities.
 * Returns the capabilities both sides have, the required ones
 * the server lacks (fatal — the client cannot proceed), and the
 * optional ones the server lacks (the client degrades gracefully).
 */
export function matchCapabilities(
  clientCapabilities: readonly ProtocolV2Capability[],
  serverCapabilities: readonly string[],
): {
  matched: string[];
  missingRequired: string[];
  missingOptional: string[];
} {
  const server = new Set(serverCapabilities);
  const matched: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  for (const cap of clientCapabilities) {
    if (server.has(cap.name)) matched.push(cap.name);
    else if (cap.required) missingRequired.push(cap.name);
    else missingOptional.push(cap.name);
  }
  return { matched, missingRequired, missingOptional };
}

/** Capability names the v2 stack knows, per family. */
export const PROTOCOL_V2_KNOWN_CAPABILITIES: Record<ProtocolV2Family, readonly string[]> = {
  mcp: [
    'tools',
    'resources',
    'prompts',
    'tasks',
    'skills',
    'apps',
    'subscriptions',
    'multiRoundTrip',
    'elicitation',
  ],
  a2a: ['signedCards', 'multiTenancy', 'streaming', 'pushNotifications', 'extendedCards'],
  agui: ['interruptResume', 'subagents', 'generativeUi', 'state', 'tokenUsage'],
  a2ui: ['forms', 'charts', 'tables', 'lists', 'media', 'actions'],
};
