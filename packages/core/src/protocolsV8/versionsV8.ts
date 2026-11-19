/**
 * Protocols v8 — version matrix + MCP extension registry (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1):
 *  - MCP spec 2026-07-28 is still the current core spec. What is
 *    new in v8 is the EXTENSION framework (SEP-2133 / SEP-3392
 *    lifecycle): extensions are negotiated through the
 *    `extensions` field of capabilities and are OFF by default.
 *    The first official extension is MCP Apps
 *    (`io.modelcontextprotocol/ui`, GA in 2026-07-28); Tasks
 *    (`io.modelcontextprotocol/tasks`) graduated from
 *    experimental (2025-11-25) to official in the same spec.
 *  - OAuth 2.1 / OIDC alignment, OAuth Client Credentials and
 *    Enterprise Managed Authorization are further extensions in
 *    the same framework; Skills over MCP and Server Cards are
 *    the remaining named extensions.
 *  - Deprecated (SEP-2577): Sampling, Roots and Logging stay
 *    runnable but must not be adopted by new code; earliest
 *    removal is the revision after 2027-07-28. HTTP+SSE is
 *    superseded by Streamable HTTP.
 *  - NANDA (survey section 6) is a local-first sketch here:
 *    discovery + self-signed identity for agents/bots, with no
 *    dependency on any central service. It is versioned as
 *    `nanda 0.1 (local sketch)` — an open-bot layer, not a
 *    standards track, exactly like `gov 1.0` in v7.
 *
 * No code, text or asset from any other repo is copied here.
 * This builds on the v7 matrix (`protocolsV7/versions.ts`)
 * without touching it: v7 pins MCP `2026-07-28` as current and
 * A2A `1.0.1` as the implemented track; v8 keeps those currents
 * and adds the extension registry, the deprecation calendar with
 * a removal date, and the NANDA local sketch.
 *
 * Version rules (v8):
 * - mcp: `2026-07-28` is current (stateless HTTP + extensions).
 *   Legacy versions leave the default surface on 2027-07-28.
 * - mcp extensions: negotiated per connection, default OFF.
 *   An extension the peer does not advertise is never used.
 * - a2a: `1.0.1` implemented track, `1.1` newer final track
 *   (unchanged from v7).
 * - ucp: `2026-08-25` read-only (unchanged from v7).
 * - acp: `merged` — no versions are spoken (unchanged).
 * - gov: `1.0` (unchanged from v7).
 * - nanda: `0.1-local` — open-bot local sketch, not a standard.
 * - agui / a2ui: `1.0` current (unchanged from v7).
 * - poppy: `1.0` current in the wider world — still watch-only.
 */

export const PROTOCOL_V8_FAMILIES = [
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
export type ProtocolV8Family = (typeof PROTOCOL_V8_FAMILIES)[number];

/** A2A versions open-bot speaks (unchanged from v7). */
export const A2A_V8_VERSIONS = ['1.1', '1.0.1', '1.0', '0.3', '0.2'] as const;
export const A2A_V8_CURRENT_VERSION = '1.0.1';
export const A2A_V8_NEWER_FINAL_VERSION = '1.1';
export const A2A_V8_STABLE_VERSION = '1.0.1';
export const A2A_V8_LEGACY_VERSIONS = ['1.0'] as const;
export const A2A_V8_REMOVED_VERSIONS = ['0.3', '0.2'] as const;

/** MCP core version (spec 2026-07-28) — stateless HTTP + extensions. */
export const MCP_V8_CURRENT_VERSION = '2026-07-28';
export const MCP_V8_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V8_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V8_LEGACY_REMOVAL_DATE = '2027-07-28';
/** Stateless HTTP: no handshake, no session id (spec 2026-07-28). */
export const MCP_V8_STATELESS = true as const;
export const MCP_V8_STATELESS_SPEC = '2026-07-28';
/** Discovery method added by the stateless core (spec 2026-07-28). */
export const MCP_V8_DISCOVER_METHOD = 'server/discover' as const;
/** MCP methods the v8 stateless transport dispatches. */
export const MCP_V8_STATELESS_METHODS = [
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'ping',
] as const;
export type McpV8StatelessMethod = (typeof MCP_V8_STATELESS_METHODS)[number];
/** MCP methods that REQUIRE a session in older specs and are refused stateless. */
export const MCP_V8_SESSION_ONLY_METHODS = ['initialize', 'notifications/initialized'] as const;
/** Elicitation stays stable in v8 (form + URL modes, from v6/v7). */
export const MCP_V8_ELICITATION_STATUS = 'stable' as const;
export const MCP_V8_ELICITATION_MODES = ['form', 'url'] as const;
export type McpV8ElicitationMode = (typeof MCP_V8_ELICITATION_MODES)[number];

/**
 * MCP extension identifiers (SEP-2133 / SEP-3392 lifecycle).
 * These are the extension NAMES as published in the spec
 * framework — identifiers, not copied text.
 */
export const MCP_V8_EXTENSION_IDS = [
  'io.modelcontextprotocol/ui',
  'io.modelcontextprotocol/tasks',
  'io.modelcontextprotocol/oauth-client-credentials',
  'io.modelcontextprotocol/enterprise-managed-authorization',
  'io.modelcontextprotocol/skills',
  'io.modelcontextprotocol/server-cards',
] as const;
export type McpV8ExtensionId = (typeof MCP_V8_EXTENSION_IDS)[number];

/** Short alias for each extension (used in logs and the UI). */
export const MCP_V8_EXTENSION_ALIASES: Record<McpV8ExtensionId, string> = {
  'io.modelcontextprotocol/ui': 'mcp-apps',
  'io.modelcontextprotocol/tasks': 'mcp-tasks',
  'io.modelcontextprotocol/oauth-client-credentials': 'oauth-client-credentials',
  'io.modelcontextprotocol/enterprise-managed-authorization': 'enterprise-managed-auth',
  'io.modelcontextprotocol/skills': 'skills-over-mcp',
  'io.modelcontextprotocol/server-cards': 'server-cards',
};

/** Lifecycle status of one MCP extension. */
export type McpV8ExtensionStatus = 'official' | 'experimental' | 'draft';

/** One extension's registry row. */
export interface McpV8ExtensionInfo {
  id: McpV8ExtensionId;
  alias: string;
  status: McpV8ExtensionStatus;
  /** Spec (or framework) date the extension became this status. */
  since: string;
  /** What the extension adds, in one line. */
  summary: string;
  /** Methods the extension adds (empty when it adds none). */
  methods: readonly string[];
  /** Whether open-bot implements it in v8. */
  implemented: boolean;
  /** Module that implements it (for the UI / docs). */
  module: string;
}

/** The v8 MCP extension registry. */
export const MCP_V8_EXTENSIONS: readonly McpV8ExtensionInfo[] = [
  {
    id: 'io.modelcontextprotocol/ui',
    alias: 'mcp-apps',
    status: 'official',
    since: '2026-07-28',
    summary:
      'MCP Apps: a tool declares UI through _meta.ui.resourceUri pointing at a ui:// resource; the host renders the HTML in a sandboxed iframe with a CSP built from the resource-declared domains.',
    methods: [],
    implemented: true,
    module: 'protocolsV8/mcpAppsV8',
  },
  {
    id: 'io.modelcontextprotocol/tasks',
    alias: 'mcp-tasks',
    status: 'official',
    since: '2026-07-28',
    summary:
      'Tasks: the server returns a task handle instead of holding the connection; the client polls tasks/get, the final result is embedded in the Task object, tasks/update feeds input mid-flight.',
    methods: ['tasks/get', 'tasks/update', 'tasks/cancel'],
    implemented: true,
    module: 'protocolsV8/mcpTasksV8',
  },
  {
    id: 'io.modelcontextprotocol/oauth-client-credentials',
    alias: 'oauth-client-credentials',
    status: 'official',
    since: '2026-07-28',
    summary:
      'OAuth Client Credentials: machine-to-machine authorization for MCP clients, aligned with OAuth 2.1 (PKCE mandatory for authorization-code flows).',
    methods: [],
    implemented: true,
    module: 'protocolsV8/oauthV8',
  },
  {
    id: 'io.modelcontextprotocol/enterprise-managed-authorization',
    alias: 'enterprise-managed-auth',
    status: 'official',
    since: '2026-07-28',
    summary:
      'Enterprise Managed Authorization: the enterprise (not the end user) manages the MCP client authorization; the client advertises that it is managed and never prompts the user for consent it does not own.',
    methods: [],
    implemented: true,
    module: 'protocolsV8/oauthV8',
  },
  {
    id: 'io.modelcontextprotocol/skills',
    alias: 'skills-over-mcp',
    status: 'official',
    since: '2026-07-28',
    summary:
      'Skills over MCP: skill packs are distributed over MCP resources with progressive disclosure (metadata first, body on demand, assets last).',
    methods: [],
    implemented: true,
    module: 'protocolsV8/skillsOverMcpV8',
  },
  {
    id: 'io.modelcontextprotocol/server-cards',
    alias: 'server-cards',
    status: 'official',
    since: '2026-07-28',
    summary:
      'Server Cards: a server advertises a card (name, description, capabilities, endpoints) so clients can discover it without a prior handshake.',
    methods: [],
    implemented: true,
    module: 'protocolsV8/nandaV8',
  },
];

/** Look up one extension by id (undefined when unknown). */
export function mcpV8ExtensionById(id: string): McpV8ExtensionInfo | undefined {
  return MCP_V8_EXTENSIONS.find((e) => e.id === id);
}

/** True when the id is a known MCP extension. */
export function mcpV8IsKnownExtension(id: string): id is McpV8ExtensionId {
  return (MCP_V8_EXTENSION_IDS as readonly string[]).includes(id);
}

/** UCP version (2026-08-25) — read-only in open-bot (unchanged from v7). */
export const UCP_V8_CURRENT_VERSION = '2026-08-25';
export const UCP_V8_VERSIONS = ['2026-08-25'] as const;
export const UCP_V8_IMPLEMENTATION = 'read-only' as const;

/** ACP merged into A2A (08/2025) — no new ACP work in v8. */
export const ACP_V8_STATUS = 'merged-into-a2a' as const;
export const ACP_V8_MERGE_DATE = '2025-08-01';
export const ACP_V8_MERGED_INTO = 'a2a';
export const ACP_V8_VERSIONS = [] as const;
export const ACP_V8_NOTE =
  'ACP (IBM) merged into A2A in 08/2025 and stopped independent development; its stateful / async long-task ideas were contributed to A2A. open-bot does no new ACP work — ACP is recorded here only so peers can be described.';

/** Governance layer — open-bot's own layer, not a standards track. */
export const GOV_V8_CURRENT_VERSION = '1.0';
export const GOV_V8_VERSIONS = ['1.0'] as const;
export const GOV_V8_STATUS = 'open-bot-layer' as const;

/** NANDA local sketch — open-bot's own layer, not a standards track. */
export const NANDA_V8_CURRENT_VERSION = '0.1-local';
export const NANDA_V8_VERSIONS = ['0.1-local'] as const;
export const NANDA_V8_STATUS = 'open-bot-local-sketch' as const;
export const NANDA_V8_NOTE =
  'NANDA-style discovery + self-signed identity, local-first sketch (v8): an in-memory registry on this machine plus Ed25519 self-signed agent identities. No central service is contacted and no central registry is trusted; a peer is trusted only when its fingerprint is pinned locally.';

/** Poppy versions known to open-bot. WATCH-ONLY — not implemented. */
export const POPPY_V8_VERSIONS = ['1.0', '0.2', '0.1'] as const;
export const POPPY_V8_CURRENT_VERSION = '1.0';
export const POPPY_V8_IMPLEMENTATION_STATUS = 'watch-only' as const;
export const POPPY_V8_IMPLEMENTATION_NOTE =
  'Poppy: watch-only, not implemented. Poppy 1.0 is tracked in the v8 registry only; open-bot opens no Poppy session and speaks no Poppy method.';

/** AG-UI 1.0 is current in v8 (unchanged from v6/v7). */
export const AGUI_V8_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V8_CURRENT_VERSION = '1.0';
export const AGUI_V8_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v8 (unchanged from v6/v7). */
export const A2UI_V8_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V8_CURRENT_VERSION = '1.0';
export const A2UI_V8_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. ACP has none — it merged into A2A. */
export const PROTOCOL_V8_CURRENT_VERSIONS: Record<ProtocolV8Family, string> = {
  a2a: A2A_V8_CURRENT_VERSION,
  mcp: MCP_V8_CURRENT_VERSION,
  ucp: UCP_V8_CURRENT_VERSION,
  acp: '',
  gov: GOV_V8_CURRENT_VERSION,
  agui: AGUI_V8_CURRENT_VERSION,
  a2ui: A2UI_V8_CURRENT_VERSION,
  poppy: POPPY_V8_CURRENT_VERSION,
  nanda: NANDA_V8_CURRENT_VERSION,
};

/** All known versions per family, newest first. ACP: none (merged). */
export const PROTOCOL_V8_VERSION_MATRIX: Record<ProtocolV8Family, readonly string[]> = {
  a2a: A2A_V8_VERSIONS,
  mcp: MCP_V8_VERSIONS,
  ucp: UCP_V8_VERSIONS,
  acp: ACP_V8_VERSIONS,
  gov: GOV_V8_VERSIONS,
  agui: AGUI_V8_VERSIONS,
  a2ui: A2UI_V8_VERSIONS,
  poppy: POPPY_V8_VERSIONS,
  nanda: NANDA_V8_VERSIONS,
};

/** Legacy (supported but deprecated / draft) versions per family. */
export const PROTOCOL_V8_LEGACY_VERSIONS: Record<ProtocolV8Family, readonly string[]> = {
  a2a: A2A_V8_LEGACY_VERSIONS,
  mcp: MCP_V8_LEGACY_VERSIONS,
  ucp: [],
  acp: [],
  gov: [],
  agui: AGUI_V8_LEGACY_VERSIONS,
  a2ui: A2UI_V8_LEGACY_VERSIONS,
  poppy: [],
  nanda: [],
};

/**
 * Deprecation entry (SEP-2577 and the transport migration).
 * One row per deprecated feature — the UI and the tools read
 * this table, never a hard-coded list.
 */
export interface McpV8DeprecationEntry {
  /** Feature name as used in code and logs. */
  feature: string;
  /** Where it was deprecated (spec / SEP reference, as an identifier). */
  deprecatedBy: string;
  /** Date it was deprecated. */
  deprecatedOn: string;
  /** Earliest removal: the revision after this date. */
  earliestRemoval: string;
  /** What to use instead. */
  replacement: string;
  /** Whether open-bot still runs it in v8 (all deprecated features still run). */
  stillRuns: boolean;
  /** Whether new code may adopt it (never, for deprecated features). */
  adoptNew: boolean;
}

/** The v8 deprecation table. */
export const MCP_V8_DEPRECATIONS: readonly McpV8DeprecationEntry[] = [
  {
    feature: 'sampling',
    deprecatedBy: 'SEP-2577',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'Elicitation (form / URL modes) for user input; the model itself decides sampling parameters locally.',
    stillRuns: true,
    adoptNew: false,
  },
  {
    feature: 'roots',
    deprecatedBy: 'SEP-2577',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'Explicit resource URIs and tool arguments; the client no longer advertises filesystem roots.',
    stillRuns: true,
    adoptNew: false,
  },
  {
    feature: 'logging',
    deprecatedBy: 'SEP-2577',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'Host-side structured logging; the logging/notification channel is not part of new integrations.',
    stillRuns: true,
    adoptNew: false,
  },
  {
    feature: 'http-sse-transport',
    deprecatedBy: 'MCP spec 2026-07-28',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'Streamable HTTP transport (stateless, one POST per request, optional SSE stream for the response).',
    stillRuns: true,
    adoptNew: false,
  },
  {
    feature: 'initialize-handshake',
    deprecatedBy: 'MCP spec 2026-07-28',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'Stateless requests: every request carries protocol version + capabilities in _meta; server/discover answers capability questions.',
    stillRuns: true,
    adoptNew: false,
  },
  {
    feature: 'mcp-session-id-header',
    deprecatedBy: 'MCP spec 2026-07-28',
    deprecatedOn: '2026-07-28',
    earliestRemoval: '2027-07-28',
    replacement: 'No session header: requests are self-describing and routable to any instance.',
    stillRuns: true,
    adoptNew: false,
  },
];

/** Look up one deprecation entry by feature name. */
export function mcpV8DeprecationByFeature(feature: string): McpV8DeprecationEntry | undefined {
  return MCP_V8_DEPRECATIONS.find((d) => d.feature === feature);
}

/** True when the feature is deprecated in v8. */
export function mcpV8IsDeprecated(feature: string): boolean {
  return MCP_V8_DEPRECATIONS.some((d) => d.feature === feature);
}

/** Lifecycle of one protocol version. */
export type ProtocolV8VersionStatus = 'current' | 'legacy' | 'removed' | 'merged' | 'watch-only' | 'local-sketch' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV8VersionError extends Error {
  readonly family: ProtocolV8Family;
  readonly code: string;
  constructor(family: ProtocolV8Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV8VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` (or `major.minor.patch`) version, or null. */
export function parseProtocolV8Semver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
}

/** Parse an MCP / UCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseProtocolV8DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV8Versions(
  family: ProtocolV8Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp' || family === 'ucp') {
    const na = parseProtocolV8DateVersion(a);
    const nb = parseProtocolV8DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  if (family === 'nanda') return a < b ? -1 : 1;
  const rank = (v: string): number => {
    if (v.endsWith('-draft') || v.endsWith('-rc')) return 0;
    return 1;
  };
  const pa = parseProtocolV8Semver(a);
  const pb = parseProtocolV8Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV8VersionStatus(
  family: ProtocolV8Family,
  version: string,
): ProtocolV8VersionStatus {
  if (family === 'acp') return 'merged';
  if (family === 'poppy') return 'watch-only';
  if (family === 'nanda') {
    return (NANDA_V8_VERSIONS as readonly string[]).includes(version) ? 'local-sketch' : 'unknown';
  }
  const matrix = PROTOCOL_V8_VERSION_MATRIX[family];
  if (!matrix.includes(version as never)) return 'unknown';
  if (family === 'a2a' && (A2A_V8_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if (family === 'a2a' && version === A2A_V8_NEWER_FINAL_VERSION) return 'current';
  if (version === PROTOCOL_V8_CURRENT_VERSIONS[family]) return 'current';
  if ((PROTOCOL_V8_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  return 'unknown';
}

/** True when the version is a draft / RC that may change incompatibly. */
export function protocolV8VersionIsUnstable(family: ProtocolV8Family, version: string): boolean {
  if (family === 'a2a') return version === '1.1-rc';
  return false;
}

/** True when open-bot actually implements (speaks) a family/version. */
export function protocolV8IsImplemented(family: ProtocolV8Family, version?: string): boolean {
  if (family === 'poppy') return false;
  if (family === 'acp') return false;
  if (version === undefined) return true;
  const status = protocolV8VersionStatus(family, version);
  return status === 'current' || status === 'legacy' || status === 'local-sketch';
}

/** One family's negotiation result. */
export interface ProtocolV8Negotiation {
  family: ProtocolV8Family;
  negotiated: string | null;
  status: ProtocolV8VersionStatus;
  /** True when the negotiated version is a draft / RC (may change). */
  unstable: boolean;
  /** True when open-bot implements the negotiated version (false for Poppy / ACP). */
  implemented: boolean;
  /** Human-readable note for the UI (empty when clean). */
  note: string;
}

/**
 * Negotiate one family's version: pick the highest version both
 * sides speak. `serverVersions` is what the peer offers (newest
 * first); the local matrix is the authority for what is current /
 * legacy / removed / merged. Returns `negotiated: null` when nothing
 * overlaps. A removed version is never picked even when both sides
 * list it. ACP always negotiates null (merged — nothing to speak);
 * Poppy negotiates a version for description purposes only — the
 * result is always marked `implemented: false`.
 */
export function negotiateProtocolV8Version(
  family: ProtocolV8Family,
  serverVersions: readonly string[] | undefined,
): ProtocolV8Negotiation {
  if (family === 'acp') {
    return {
      family,
      negotiated: null,
      status: 'merged',
      unstable: false,
      implemented: false,
      note: ACP_V8_NOTE,
    };
  }
  if (family === 'nanda') {
    const offered = serverVersions ?? [];
    const common = (NANDA_V8_VERSIONS as readonly string[]).find((v) => offered.includes(v));
    if (common === undefined) {
      return {
        family,
        negotiated: null,
        status: 'unknown',
        unstable: false,
        implemented: true,
        note: 'No common NANDA sketch version (local-only; the peer does not speak the local sketch).',
      };
    }
    return {
      family,
      negotiated: common,
      status: 'local-sketch',
      unstable: false,
      implemented: true,
      note: NANDA_V8_NOTE,
    };
  }
  const local = PROTOCOL_V8_VERSION_MATRIX[family];
  const offered = serverVersions ?? [];
  for (const candidate of local) {
    if (!offered.includes(candidate)) continue;
    const status = protocolV8VersionStatus(family, candidate);
    if (status === 'removed') continue;
    const unstable = protocolV8VersionIsUnstable(family, candidate);
    const implemented = protocolV8IsImplemented(family, candidate);
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
            ? `${family} ${candidate} is legacy; upgrade to ${PROTOCOL_V8_CURRENT_VERSIONS[family]}.`
            : '',
    };
  }
  return {
    family,
    negotiated: null,
    status: 'unknown',
    unstable: false,
    implemented: false,
    note: `No common ${family} version (local: ${local.join(', ') || 'none — merged'}; peer: ${offered.join(', ') || 'none'}).`,
  };
}

/** Negotiate every family at once. */
export function negotiateAllProtocolsV8(
  serverVersions: Partial<Record<ProtocolV8Family, readonly string[]>>,
): Record<ProtocolV8Family, ProtocolV8Negotiation> {
  const out = {} as Record<ProtocolV8Family, ProtocolV8Negotiation>;
  for (const family of PROTOCOL_V8_FAMILIES) {
    out[family] = negotiateProtocolV8Version(family, serverVersions[family]);
  }
  return out;
}

/**
 * Capability advertisement: what this client supports beyond
 * bare versions. Extensions are negotiated separately (see
 * below) and are OFF unless both sides advertise them.
 */
export interface ProtocolV8CapabilityAdvertisement {
  /** A2A v1.0.1 complete client/server (card JWS, multi-tenancy, long tasks). */
  a2aComplete101: boolean;
  /** A2A 1.1 two-way streaming (from v6). */
  a2aTwoWayStreaming: boolean;
  /** MCP stateless HTTP (spec 2026-07-28): no handshake, no session id. */
  mcpStatelessHttp: boolean;
  /** MCP server/discover (spec 2026-07-28): ask capabilities before calling. */
  mcpDiscover: boolean;
  /** UCP read-only (catalog / cart / order lookup; no checkout/payment). */
  ucpReadOnly: boolean;
  /** Governance layer: delegation with revocation + escalation. */
  governance: boolean;
  /** NANDA local sketch: registry discovery + self-signed identity. */
  nandaLocal: boolean;
  /** Elicitation modes the client supports (client advertises; agent picks). */
  elicitationModes: McpV8ElicitationMode[];
}

/** The default capability advertisement for open-bot v8. */
export function defaultProtocolV8Capabilities(): ProtocolV8CapabilityAdvertisement {
  return {
    a2aComplete101: true,
    a2aTwoWayStreaming: true,
    mcpStatelessHttp: true,
    mcpDiscover: true,
    ucpReadOnly: true,
    governance: true,
    nandaLocal: true,
    elicitationModes: [...MCP_V8_ELICITATION_MODES],
  };
}

/**
 * Negotiate capabilities against a peer's advertisement: the
 * intersection is what both sides may use. A missing peer
 * advertisement means "nothing beyond versions" (safe default).
 */
export function negotiateProtocolV8Capabilities(
  peer: Partial<ProtocolV8CapabilityAdvertisement> | undefined,
): ProtocolV8CapabilityAdvertisement {
  const local = defaultProtocolV8Capabilities();
  if (!peer) {
    return {
      a2aComplete101: false,
      a2aTwoWayStreaming: false,
      mcpStatelessHttp: false,
      mcpDiscover: false,
      ucpReadOnly: false,
      governance: false,
      nandaLocal: false,
      elicitationModes: [],
    };
  }
  return {
    a2aComplete101: local.a2aComplete101 && peer.a2aComplete101 === true,
    a2aTwoWayStreaming: local.a2aTwoWayStreaming && peer.a2aTwoWayStreaming === true,
    mcpStatelessHttp: local.mcpStatelessHttp && peer.mcpStatelessHttp === true,
    mcpDiscover: local.mcpDiscover && peer.mcpDiscover === true,
    ucpReadOnly: local.ucpReadOnly && peer.ucpReadOnly === true,
    governance: local.governance && peer.governance === true,
    nandaLocal: local.nandaLocal && peer.nandaLocal === true,
    elicitationModes: local.elicitationModes.filter((m) => (peer.elicitationModes ?? []).includes(m)),
  };
}

/**
 * Extension negotiation (SEP-2133 / SEP-3392 lifecycle).
 * Extensions are OFF by default: an extension is active only
 * when BOTH sides list it in the `extensions` field of their
 * capabilities. An unknown extension id is ignored (never
 * activated) and reported, so a peer cannot switch on a
 * capability open-bot does not know.
 */
export interface McpV8ExtensionNegotiation {
  /** Extensions both sides advertised (active for this connection). */
  active: McpV8ExtensionId[];
  /** Extensions the local side offered but the peer did not. */
  localOnly: McpV8ExtensionId[];
  /** Extensions the peer offered but the local side does not know or does not implement. */
  peerOnly: string[];
  /** Unknown peer extension ids (ignored, never activated). */
  unknown: string[];
  /** True when the Tasks extension is active (tools/call may return task handles). */
  tasksActive: boolean;
  /** True when the MCP Apps extension is active (tools may declare UI). */
  appsActive: boolean;
  /** True when the Skills over MCP extension is active. */
  skillsActive: boolean;
}

/** Negotiate extensions between the local offer and the peer offer. */
export function negotiateMcpV8Extensions(
  localOffer: readonly string[] | undefined,
  peerOffer: readonly string[] | undefined,
): McpV8ExtensionNegotiation {
  const localKnown = (localOffer ?? []).filter((id) => mcpV8IsKnownExtension(id)) as McpV8ExtensionId[];
  const localSet = new Set<string>(localKnown);
  const peer = peerOffer ?? [];
  const peerKnown = peer.filter((id) => mcpV8IsKnownExtension(id)) as McpV8ExtensionId[];
  const unknown = peer.filter((id) => !mcpV8IsKnownExtension(id));
  const active = peerKnown.filter((id) => localSet.has(id) && (mcpV8ExtensionById(id)?.implemented === true));
  const localOnly = localKnown.filter((id) => !peer.includes(id));
  const peerOnly = peer.filter((id) => !localSet.has(id));
  return {
    active,
    localOnly,
    peerOnly,
    unknown,
    tasksActive: active.includes('io.modelcontextprotocol/tasks'),
    appsActive: active.includes('io.modelcontextprotocol/ui'),
    skillsActive: active.includes('io.modelcontextprotocol/skills'),
  };
}

/** The local default extension offer (all implemented extensions). */
export function defaultMcpV8ExtensionOffer(): McpV8ExtensionId[] {
  return MCP_V8_EXTENSIONS.filter((e) => e.implemented).map((e) => e.id);
}

/**
 * Downgrade check: can a v8 client talk to a peer that only speaks
 * the v7 matrix? Returns the families that still negotiate and the
 * ones that lose their current version.
 */
export interface ProtocolV8DowngradeReport {
  family: ProtocolV8Family;
  v8Current: string;
  v7Negotiated: string | null;
  compatible: boolean;
  implemented: boolean;
  note: string;
}

export function protocolV8DowngradeToV7(): ProtocolV8DowngradeReport[] {
  const v7Offered: Partial<Record<ProtocolV8Family, readonly string[]>> = {
    a2a: ['1.1', '1.0.1', '1.0'],
    mcp: ['2026-07-28', '2025-11-25'],
    ucp: ['2026-08-25'],
    acp: [],
    gov: ['1.0'],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
    poppy: ['1.0', '0.2', '0.1'],
    nanda: [],
  };
  return PROTOCOL_V8_FAMILIES.map((family) => {
    const negotiated = negotiateProtocolV8Version(family, v7Offered[family]);
    const compatible = negotiated.negotiated !== null;
    let note: string;
    if (family === 'acp') {
      note = 'ACP merged into A2A; a v7 peer offers no ACP versions and v8 opens no ACP session — use A2A instead.';
    } else if (family === 'nanda') {
      note = 'NANDA local sketch is new in v8; a v7 peer speaks no NANDA, so discovery / self-signed identity stay local-only.';
    } else if (family === 'poppy') {
      note = 'Poppy is watch-only in both v7 and v8; no Poppy session is ever opened.';
    } else if (compatible) {
      note = `Negotiates ${negotiated.negotiated} with a v7 peer${negotiated.unstable ? ' (draft/RC)' : ''}; v8-only capabilities (server/discover, MCP extensions, OAuth 2.1 alignment, NANDA local sketch) are unavailable with a v7 peer.`;
    } else {
      note = `No common ${family} version with a v7 peer.`;
    }
    return {
      family,
      v8Current: PROTOCOL_V8_CURRENT_VERSIONS[family],
      v7Negotiated: negotiated.negotiated,
      compatible,
      implemented: negotiated.implemented,
      note,
    };
  });
}

/**
 * Deprecation calendar for the v8 surface — one row per family, so
 * the UI can say what is current, what is legacy-but-supported,
 * what is removed or merged, and when the legacy surface leaves.
 */
export interface ProtocolV8DeprecationRow {
  family: ProtocolV8Family;
  current: string;
  legacy: readonly string[];
  removed: readonly string[];
  removalDate: string;
  note: string;
}

export function protocolV8DeprecationCalendar(): ProtocolV8DeprecationRow[] {
  return [
    {
      family: 'a2a',
      current: A2A_V8_CURRENT_VERSION,
      legacy: A2A_V8_LEGACY_VERSIONS,
      removed: A2A_V8_REMOVED_VERSIONS,
      removalDate: '',
      note: '1.0.1 is the first stable release; 1.1 is the newer final track, also supported. JWS-signed Agent Cards, multi-tenancy and long-running async tasks are the v7/v8 complete surface.',
    },
    {
      family: 'mcp',
      current: MCP_V8_CURRENT_VERSION,
      legacy: MCP_V8_LEGACY_VERSIONS,
      removed: [],
      removalDate: MCP_V8_LEGACY_REMOVAL_DATE,
      note: 'Stateless HTTP (spec 2026-07-28) + extensions: no handshake, no session id, every request self-describing; server/discover answers capability questions. Sampling / Roots / Logging are deprecated (SEP-2577) and leave after 2027-07-28; HTTP+SSE is superseded by Streamable HTTP.',
    },
    {
      family: 'ucp',
      current: UCP_V8_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: 'UCP checkout / payment / order placement is refused in open-bot: the standing direction drops payments, accounts and cloud. UCP is read-only here (catalog / cart / order lookup).',
    },
    {
      family: 'acp',
      current: '',
      legacy: [],
      removed: [],
      removalDate: ACP_V8_MERGE_DATE,
      note: ACP_V8_NOTE,
    },
    {
      family: 'gov',
      current: GOV_V8_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: 'Governance is open-bot\'s own layer (v7/v8): delegation with revocation + escalation to the user, constraints, and a hash-chained audit log.',
    },
    {
      family: 'agui',
      current: AGUI_V8_CURRENT_VERSION,
      legacy: AGUI_V8_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '1.0 freezes 31 event types; THINKING_* removed, use REASONING_*.',
    },
    {
      family: 'a2ui',
      current: A2UI_V8_CURRENT_VERSION,
      legacy: A2UI_V8_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '',
    },
    {
      family: 'poppy',
      current: POPPY_V8_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: POPPY_V8_IMPLEMENTATION_NOTE,
    },
    {
      family: 'nanda',
      current: NANDA_V8_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: NANDA_V8_NOTE,
    },
  ];
}

/** One-line summary of the v8 matrix, for logs and the UI. */
export function protocolV8MatrixSummary(): string {
  return PROTOCOL_V8_FAMILIES.map(
    (f) => `${f} ${PROTOCOL_V8_CURRENT_VERSIONS[f] || 'merged'}`,
  ).join(' · ');
}

/**
 * What changed between the v7 and v8 matrices (for the changelog
 * and the UI).
 */
export function protocolV8ChangesSinceV7(): string[] {
  return [
    'MCP extension framework (SEP-2133 / SEP-3392): extensions are negotiated through the extensions field of capabilities and are OFF by default; the registry lists 6 extensions (MCP Apps, Tasks, OAuth Client Credentials, Enterprise Managed Authorization, Skills over MCP, Server Cards), all implemented in v8.',
    'server/discover: the stateless core answers capability questions before any tool call — protocol version, capabilities and extensions in one document, no handshake.',
    'MCP Apps (io.modelcontextprotocol/ui, official in spec 2026-07-28): tools declare UI through _meta.ui.resourceUri pointing at a ui:// resource; the host renders it in a sandboxed iframe with a CSP built from the resource-declared domains.',
    'Tasks (io.modelcontextprotocol/tasks, official in spec 2026-07-28): tools/call returns a task handle; tasks/get polls non-blocking, the final result is embedded in the Task object; tasks/update feeds input mid-flight; tasks/result (blocking) and tasks/list are gone.',
    'OAuth 2.1 / OIDC alignment: PKCE (S256) is mandatory for authorization-code flows; redirect URIs are exact-matched (https, loopback http only); Client Credentials and Enterprise Managed Authorization are negotiated extensions.',
    'Deprecation handling (SEP-2577): Sampling, Roots and Logging are marked deprecated with a removal floor of 2027-07-28, a warning is emitted on every deprecated use, and Streamable HTTP is the preferred transport over HTTP+SSE.',
    'NANDA local sketch (0.1-local): in-memory registry discovery + Ed25519 self-signed agent identity, local-first — no central service is contacted or trusted.',
    'Skills over MCP: skill packs are distributed over MCP resources with progressive disclosure (metadata, then body, then assets).',
    'Poppy 1.0: still watch-only, not implemented. ACP: still merged into A2A.',
  ];
}

/** True when the family/version pair may be used on the v8 surface. */
export function protocolV8IsUsable(family: ProtocolV8Family, version: string): boolean {
  return protocolV8IsImplemented(family, version);
}

/** Transport preference: Streamable HTTP first, HTTP+SSE last (deprecated). */
export const MCP_V8_TRANSPORT_PREFERENCE = ['streamable-http', 'stdio', 'http-sse'] as const;
export type McpV8Transport = (typeof MCP_V8_TRANSPORT_PREFERENCE)[number];

/** True when the transport is the preferred one (Streamable HTTP). */
export function mcpV8IsPreferredTransport(transport: string): boolean {
  return transport === 'streamable-http';
}

/** True when the transport is deprecated and must warn on use. */
export function mcpV8IsDeprecatedTransport(transport: string): boolean {
  return transport === 'http-sse';
}
