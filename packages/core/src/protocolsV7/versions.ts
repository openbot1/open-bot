/**
 * Protocols v7 — version matrix + unified negotiation (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md (section 1):
 *  - A2A v1.0.1 (05/2026) is the first stable A2A release with the
 *    v1.0.1 patch set: JWS-signed Agent Cards, multi-protocol and
 *    multi-tenancy. ACP merged into A2A (08/2025) and stopped
 *    independent development — v7 does NO new ACP work; ACP is
 *    recorded here as "merged" so peers can be described, never so
 *    an ACP session is opened.
 *  - MCP spec 2026-07-28: HTTP is stateless — no handshake, no
 *    session id, every request self-describing and routable to any
 *    instance. The stateless transport lives in
 *    `mcpStatelessV7.ts`; this file only records the versions.
 *  - UCP v2026-08-25 (Google + Shopify + Stripe): catalog search,
 *    cart, identity linking, checkout, order management. Huy's
 *    standing direction drops payments / accounts / cloud, so v7
 *    implements UCP READ-ONLY (catalog / cart / order lookup) and
 *    refuses every money-moving operation by construction — see
 *    `ucpReadOnlyV7.ts`. The matrix marks checkout/payment as
 *    "refused", never as "unimplemented-yet".
 *  - Governance gap: all five surveyed protocols lack a
 *    governance layer (delegation, constraint, revocation scored
 *    2/12; voting / dissent / human escalation absent everywhere).
 *    v7 adds open-bot's own governance layer on top
 *    (`governanceV7.ts`): delegation with revocation + escalation
 *    to the user. It is versioned here as `gov 1.0` — an open-bot
 *    layer, not a standards track.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the v6 matrix (`protocolsV6/versions.ts`)
 * without touching it: v6 pins A2A `1.1` as current and MCP
 * `2026-07-28` as current; v7 keeps those currents, adds the
 * A2A `1.0.1` stable track (the first stable release — the one
 * v7 implements completely), adds UCP and the governance layer,
 * and retires ACP to "merged".
 *
 * Version rules (v7):
 * - a2a: `1.0.1` is the implemented stable track; `1.1` is the
 *   newer final track (v6 already speaks it); `1.0` legacy;
 *   `0.3`/`0.2` removed.
 * - mcp: `2026-07-28` is current (stateless HTTP); legacy
 *   versions leave the default surface on 2027-07-28.
 * - ucp: `2026-08-25` is current — read-only in open-bot.
 * - acp: `merged` — no versions are spoken; recorded only.
 * - gov: `1.0` is current (open-bot's own governance layer).
 * - agui / a2ui: `1.0` current (unchanged from v6).
 * - poppy: `1.0` current in the wider world — still watch-only,
 *   not implemented (same as v6).
 */

export const PROTOCOL_V7_FAMILIES = ['a2a', 'mcp', 'ucp', 'acp', 'gov', 'agui', 'a2ui', 'poppy'] as const;
export type ProtocolV7Family = (typeof PROTOCOL_V7_FAMILIES)[number];

/** A2A versions open-bot speaks. `1.0.1` is the v7 implemented track. */
export const A2A_V7_VERSIONS = ['1.1', '1.0.1', '1.0', '0.3', '0.2'] as const;
export const A2A_V7_CURRENT_VERSION = '1.0.1';
export const A2A_V7_NEWER_FINAL_VERSION = '1.1';
export const A2A_V7_STABLE_VERSION = '1.0.1';
export const A2A_V7_LEGACY_VERSIONS = ['1.0'] as const;
export const A2A_V7_REMOVED_VERSIONS = ['0.3', '0.2'] as const;
/** A2A v1.0.1: the first stable release (Linux Foundation / Agentic AI Foundation). */
export const A2A_V7_STABLE_RELEASE_DATE = '2026-03-01';
export const A2A_V7_PATCH_RELEASE = '1.0.1';
export const A2A_V7_PATCH_RELEASE_DATE = '2026-05-01';
export const A2A_V7_GOVERNANCE = 'Linux Foundation';
export const A2A_V7_AGENT_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';
export const A2A_V7_AGENT_CARD_JWS_MEDIA_TYPE = 'application/jwt';
export const A2A_V7_WELL_KNOWN_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_V7_WELL_KNOWN_CARD_JWS_PATH = '/.well-known/agent-card.jws';
/** JSON-RPC methods an A2A v1.0.1 server must answer (v7 surface). */
export const A2A_V7_METHODS = [
  'message/send',
  'message/stream',
  'tasks/get',
  'tasks/cancel',
  'tasks/list',
  'tasks/resubscribe',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
] as const;
export type A2aV7Method = (typeof A2A_V7_METHODS)[number];
/** Methods that are new in v7 versus the v6 A2A surface. */
export const A2A_V7_NEW_METHODS = [
  'tasks/list',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
] as const;
/** A2A v1.0.1 task states (long-running async lifecycle). */
export const A2A_V7_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;
export type A2aV7TaskState = (typeof A2A_V7_TASK_STATES)[number];
/** Terminal task states — no further transition is legal. */
export const A2A_V7_TERMINAL_TASK_STATES: readonly A2aV7TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];
/** Multi-tenancy header (same wire name as the v1.07 tenancy layer). */
export const A2A_V7_TENANT_HEADER = 'x-a2a-tenant';
export const A2A_V7_DEFAULT_TENANT = 'default';

/** MCP core version (spec 2026-07-28) — stateless HTTP in v7. */
export const MCP_V7_CURRENT_VERSION = '2026-07-28';
export const MCP_V7_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
export const MCP_V7_LEGACY_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
/** Date the legacy MCP surface leaves the default build. */
export const MCP_V7_LEGACY_REMOVAL_DATE = '2027-07-28';
/** Stateless HTTP: no handshake, no session id (spec 2026-07-28). */
export const MCP_V7_STATELESS = true as const;
export const MCP_V7_STATELESS_SPEC = '2026-07-28';
/** MCP methods the v7 stateless transport dispatches. */
export const MCP_V7_STATELESS_METHODS = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'ping',
] as const;
export type McpV7StatelessMethod = (typeof MCP_V7_STATELESS_METHODS)[number];
/** MCP methods that REQUIRE a session in older specs and are refused stateless. */
export const MCP_V7_SESSION_ONLY_METHODS = ['initialize', 'notifications/initialized'] as const;
/** Elicitation stays stable in v7 (form + URL modes, from v6). */
export const MCP_V7_ELICITATION_STATUS = 'stable' as const;
export const MCP_V7_ELICITATION_MODES = ['form', 'url'] as const;
export type McpV7ElicitationMode = (typeof MCP_V7_ELICITATION_MODES)[number];

/** UCP version (2026-08-25) — read-only in open-bot. */
export const UCP_V7_CURRENT_VERSION = '2026-08-25';
export const UCP_V7_VERSIONS = ['2026-08-25'] as const;
export const UCP_V7_IMPLEMENTATION = 'read-only' as const;
/** UCP operations open-bot implements (read-only: never moves money). */
export const UCP_V7_READ_OPERATIONS = [
  'catalog/search',
  'catalog/get',
  'catalog/list',
  'cart/get',
  'order/get',
  'order/list',
  'identity/status',
] as const;
export type UcpV7ReadOperation = (typeof UCP_V7_READ_OPERATIONS)[number];
/** UCP operations REFUSED by construction (money-moving). */
export const UCP_V7_REFUSED_OPERATIONS = [
  'checkout/create',
  'checkout/complete',
  'payment/authorize',
  'payment/capture',
  'payment/refund',
  'order/place',
  'cart/add',
  'cart/checkout',
] as const;
export type UcpV7RefusedOperation = (typeof UCP_V7_REFUSED_OPERATIONS)[number];
/** Why UCP money operations are refused (standing direction). */
export const UCP_V7_REFUSAL_NOTE =
  'UCP checkout / payment / order placement is refused in open-bot: the standing direction drops payments, accounts and cloud. UCP is read-only here (catalog / cart / order lookup).';

/** ACP merged into A2A (08/2025) — no new ACP work in v7. */
export const ACP_V7_STATUS = 'merged-into-a2a' as const;
export const ACP_V7_MERGE_DATE = '2025-08-01';
export const ACP_V7_MERGED_INTO = 'a2a';
export const ACP_V7_VERSIONS = [] as const;
export const ACP_V7_NOTE =
  'ACP (IBM) merged into A2A in 08/2025 and stopped independent development; its stateful / async long-task ideas were contributed to A2A. open-bot does no new ACP work — ACP is recorded here only so peers can be described.';

/** Governance layer — open-bot's own layer, not a standards track. */
export const GOV_V7_CURRENT_VERSION = '1.0';
export const GOV_V7_VERSIONS = ['1.0'] as const;
export const GOV_V7_STATUS = 'open-bot-layer' as const;
/** Governance capabilities (the gap all five surveyed protocols miss). */
export const GOV_V7_CAPABILITIES = [
  'delegate',
  'revoke',
  'escalate',
  'constrain',
  'audit',
] as const;
export type GovV7Capability = (typeof GOV_V7_CAPABILITIES)[number];
export const GOV_V7_NOTE =
  'Governance is open-bot\'s own layer (v7): delegation with revocation + escalation to the user, constraints, and a hash-chained audit log. It covers the gap every surveyed protocol leaves open — delegation, constraint and revocation scored 2/12, voting / dissent / human escalation absent everywhere.';

/** Poppy versions known to open-bot. WATCH-ONLY — not implemented. */
export const POPPY_V7_VERSIONS = ['1.0', '0.2', '0.1'] as const;
export const POPPY_V7_CURRENT_VERSION = '1.0';
export const POPPY_V7_IMPLEMENTATION_STATUS = 'watch-only' as const;
export const POPPY_V7_IMPLEMENTATION_NOTE =
  'Poppy: watch-only, not implemented. Poppy 1.0 is tracked in the v7 registry only; open-bot opens no Poppy session and speaks no Poppy method.';

/** AG-UI 1.0 is current in v7 (unchanged from v6). */
export const AGUI_V7_VERSIONS = ['1.0', '0.0.1'] as const;
export const AGUI_V7_CURRENT_VERSION = '1.0';
export const AGUI_V7_LEGACY_VERSIONS = ['0.0.1'] as const;

/** A2UI 1.0 is current in v7 (unchanged from v6). */
export const A2UI_V7_VERSIONS = ['1.0', '0.1'] as const;
export const A2UI_V7_CURRENT_VERSION = '1.0';
export const A2UI_V7_LEGACY_VERSIONS = ['0.1'] as const;

/** Current version per family. ACP has none — it merged into A2A. */
export const PROTOCOL_V7_CURRENT_VERSIONS: Record<ProtocolV7Family, string> = {
  a2a: A2A_V7_CURRENT_VERSION,
  mcp: MCP_V7_CURRENT_VERSION,
  ucp: UCP_V7_CURRENT_VERSION,
  acp: '',
  gov: GOV_V7_CURRENT_VERSION,
  agui: AGUI_V7_CURRENT_VERSION,
  a2ui: A2UI_V7_CURRENT_VERSION,
  poppy: POPPY_V7_CURRENT_VERSION,
};

/** All known versions per family, newest first. ACP: none (merged). */
export const PROTOCOL_V7_VERSION_MATRIX: Record<ProtocolV7Family, readonly string[]> = {
  a2a: A2A_V7_VERSIONS,
  mcp: MCP_V7_VERSIONS,
  ucp: UCP_V7_VERSIONS,
  acp: ACP_V7_VERSIONS,
  gov: GOV_V7_VERSIONS,
  agui: AGUI_V7_VERSIONS,
  a2ui: A2UI_V7_VERSIONS,
  poppy: POPPY_V7_VERSIONS,
};

/** Legacy (supported but deprecated / draft) versions per family. */
export const PROTOCOL_V7_LEGACY_VERSIONS: Record<ProtocolV7Family, readonly string[]> = {
  a2a: A2A_V7_LEGACY_VERSIONS,
  mcp: MCP_V7_LEGACY_VERSIONS,
  ucp: [],
  acp: [],
  gov: [],
  agui: AGUI_V7_LEGACY_VERSIONS,
  a2ui: A2UI_V7_LEGACY_VERSIONS,
  poppy: [],
};

/** Lifecycle of one protocol version. */
export type ProtocolV7VersionStatus = 'current' | 'legacy' | 'removed' | 'merged' | 'watch-only' | 'unknown';

/** Error raised when negotiation cannot pick a usable version. */
export class ProtocolV7VersionError extends Error {
  readonly family: ProtocolV7Family;
  readonly code: string;
  constructor(family: ProtocolV7Family, code: string, message: string) {
    super(message);
    this.name = 'ProtocolV7VersionError';
    this.family = family;
    this.code = code;
  }
}

/** Parse a `major.minor` (or `major.minor.patch`) version, or null. */
export function parseProtocolV7Semver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
}

/** Parse an MCP / UCP `YYYY-MM-DD` version into a sortable number, or null. */
export function parseProtocolV7DateVersion(version: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version.trim());
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Compare two versions of one family: -1 / 0 / 1 (a < b, a = b, a > b). */
export function compareProtocolV7Versions(
  family: ProtocolV7Family,
  a: string,
  b: string,
): number {
  if (a === b) return 0;
  if (family === 'mcp' || family === 'ucp') {
    const na = parseProtocolV7DateVersion(a);
    const nb = parseProtocolV7DateVersion(b);
    if (na === null || nb === null) return a < b ? -1 : 1;
    return na < nb ? -1 : 1;
  }
  const rank = (v: string): number => {
    if (v.endsWith('-draft') || v.endsWith('-rc')) return 0;
    return 1;
  };
  const pa = parseProtocolV7Semver(a);
  const pb = parseProtocolV7Semver(b);
  if (!pa || !pb) return a < b ? -1 : 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  return 0;
}

/** Lifecycle status of one version of one family. */
export function protocolV7VersionStatus(
  family: ProtocolV7Family,
  version: string,
): ProtocolV7VersionStatus {
  if (family === 'acp') return 'merged';
  if (family === 'poppy') return 'watch-only';
  const matrix = PROTOCOL_V7_VERSION_MATRIX[family];
  if (!matrix.includes(version as never)) return 'unknown';
  if (family === 'a2a' && (A2A_V7_REMOVED_VERSIONS as readonly string[]).includes(version)) {
    return 'removed';
  }
  if (family === 'a2a' && version === A2A_V7_NEWER_FINAL_VERSION) return 'current';
  if (version === PROTOCOL_V7_CURRENT_VERSIONS[family]) return 'current';
  if ((PROTOCOL_V7_LEGACY_VERSIONS[family] as readonly string[]).includes(version)) {
    return 'legacy';
  }
  return 'unknown';
}

/** True when the version is a draft / RC that may change incompatibly. */
export function protocolV7VersionIsUnstable(family: ProtocolV7Family, version: string): boolean {
  if (family === 'a2a') return version === '1.1-rc';
  return false;
}

/** True when open-bot actually implements (speaks) a family/version. */
export function protocolV7IsImplemented(family: ProtocolV7Family, version?: string): boolean {
  if (family === 'poppy') return false;
  if (family === 'acp') return false;
  if (version === undefined) return true;
  const status = protocolV7VersionStatus(family, version);
  return status === 'current' || status === 'legacy';
}

/** One family's negotiation result. */
export interface ProtocolV7Negotiation {
  family: ProtocolV7Family;
  negotiated: string | null;
  status: ProtocolV7VersionStatus;
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
export function negotiateProtocolV7Version(
  family: ProtocolV7Family,
  serverVersions: readonly string[] | undefined,
): ProtocolV7Negotiation {
  if (family === 'acp') {
    return {
      family,
      negotiated: null,
      status: 'merged',
      unstable: false,
      implemented: false,
      note: ACP_V7_NOTE,
    };
  }
  const local = PROTOCOL_V7_VERSION_MATRIX[family];
  const offered = serverVersions ?? [];
  for (const candidate of local) {
    if (!offered.includes(candidate)) continue;
    const status = protocolV7VersionStatus(family, candidate);
    if (status === 'removed') continue;
    const unstable = protocolV7VersionIsUnstable(family, candidate);
    const implemented = protocolV7IsImplemented(family, candidate);
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
            ? `${family} ${candidate} is legacy; upgrade to ${PROTOCOL_V7_CURRENT_VERSIONS[family]}.`
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
export function negotiateAllProtocolsV7(
  serverVersions: Partial<Record<ProtocolV7Family, readonly string[]>>,
): Record<ProtocolV7Family, ProtocolV7Negotiation> {
  const out = {} as Record<ProtocolV7Family, ProtocolV7Negotiation>;
  for (const family of PROTOCOL_V7_FAMILIES) {
    out[family] = negotiateProtocolV7Version(family, serverVersions[family]);
  }
  return out;
}

/** Capability advertisement: what this client supports beyond bare versions. */
export interface ProtocolV7CapabilityAdvertisement {
  /** A2A v1.0.1 complete client/server (card JWS, multi-tenancy, long tasks). */
  a2aComplete101: boolean;
  /** A2A 1.1 two-way streaming (from v6). */
  a2aTwoWayStreaming: boolean;
  /** MCP stateless HTTP (spec 2026-07-28): no handshake, no session id. */
  mcpStatelessHttp: boolean;
  /** UCP read-only (catalog / cart / order lookup; no checkout/payment). */
  ucpReadOnly: boolean;
  /** Governance layer: delegation with revocation + escalation. */
  governance: boolean;
  /** Elicitation modes the client supports (client advertises; agent picks). */
  elicitationModes: McpV7ElicitationMode[];
}

/** The default capability advertisement for open-bot v7. */
export function defaultProtocolV7Capabilities(): ProtocolV7CapabilityAdvertisement {
  return {
    a2aComplete101: true,
    a2aTwoWayStreaming: true,
    mcpStatelessHttp: true,
    ucpReadOnly: true,
    governance: true,
    elicitationModes: [...MCP_V7_ELICITATION_MODES],
  };
}

/**
 * Negotiate capabilities against a peer's advertisement: the
 * intersection is what both sides may use. A missing peer
 * advertisement means "nothing beyond versions" (safe default).
 */
export function negotiateProtocolV7Capabilities(
  peer: Partial<ProtocolV7CapabilityAdvertisement> | undefined,
): ProtocolV7CapabilityAdvertisement {
  const local = defaultProtocolV7Capabilities();
  if (!peer) {
    return {
      a2aComplete101: false,
      a2aTwoWayStreaming: false,
      mcpStatelessHttp: false,
      ucpReadOnly: false,
      governance: false,
      elicitationModes: [],
    };
  }
  return {
    a2aComplete101: local.a2aComplete101 && peer.a2aComplete101 === true,
    a2aTwoWayStreaming: local.a2aTwoWayStreaming && peer.a2aTwoWayStreaming === true,
    mcpStatelessHttp: local.mcpStatelessHttp && peer.mcpStatelessHttp === true,
    ucpReadOnly: local.ucpReadOnly && peer.ucpReadOnly === true,
    governance: local.governance && peer.governance === true,
    elicitationModes: local.elicitationModes.filter((m) => (peer.elicitationModes ?? []).includes(m)),
  };
}

/**
 * Downgrade check: can a v7 client talk to a peer that only speaks
 * the v6 matrix? Returns the families that still negotiate and the
 * ones that lose their current version.
 */
export interface ProtocolV7DowngradeReport {
  family: ProtocolV7Family;
  v7Current: string;
  v6Negotiated: string | null;
  compatible: boolean;
  implemented: boolean;
  note: string;
}

export function protocolV7DowngradeToV6(): ProtocolV7DowngradeReport[] {
  const v6Offered: Partial<Record<ProtocolV7Family, readonly string[]>> = {
    a2a: ['1.1', '1.1-rc', '1.0'],
    mcp: ['2026-07-28', '2025-11-25'],
    ucp: [],
    acp: ['2.0-draft', '1.0'],
    gov: [],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
    poppy: ['1.0', '0.2', '0.1'],
  };
  return PROTOCOL_V7_FAMILIES.map((family) => {
    const negotiated = negotiateProtocolV7Version(family, v6Offered[family]);
    const compatible = negotiated.negotiated !== null;
    let note: string;
    if (family === 'acp') {
      note = 'ACP merged into A2A; a v6 peer offering ACP versions gets no ACP session from v7 — use A2A instead.';
    } else if (family === 'ucp') {
      note = 'UCP is new in v7; a v6 peer speaks no UCP, so no UCP operations are available with it.';
    } else if (family === 'gov') {
      note = 'Governance is open-bot\'s own v7 layer; a v6 peer has no governance, so delegation / revocation / escalation stay local-only.';
    } else if (family === 'poppy') {
      note = 'Poppy is watch-only in both v6 and v7; no Poppy session is ever opened.';
    } else if (compatible) {
      note = `Negotiates ${negotiated.negotiated} with a v6 peer${negotiated.unstable ? ' (draft/RC)' : ''}; v7-only capabilities (A2A 1.0.1 complete client/server, MCP stateless HTTP, UCP read-only, governance) are unavailable with a v6 peer.`;
    } else {
      note = `No common ${family} version with a v6 peer.`;
    }
    return {
      family,
      v7Current: PROTOCOL_V7_CURRENT_VERSIONS[family],
      v6Negotiated: negotiated.negotiated,
      compatible,
      implemented: negotiated.implemented,
      note,
    };
  });
}

/**
 * Deprecation calendar for the v7 surface — one row per family, so
 * the UI can say what is current, what is legacy-but-supported,
 * what is removed or merged, and when the legacy surface leaves.
 */
export interface ProtocolV7DeprecationRow {
  family: ProtocolV7Family;
  current: string;
  legacy: readonly string[];
  removed: readonly string[];
  removalDate: string;
  note: string;
}

export function protocolV7DeprecationCalendar(): ProtocolV7DeprecationRow[] {
  return [
    {
      family: 'a2a',
      current: A2A_V7_CURRENT_VERSION,
      legacy: A2A_V7_LEGACY_VERSIONS,
      removed: A2A_V7_REMOVED_VERSIONS,
      removalDate: '',
      note: `1.0.1 is the first stable release (${A2A_V7_GOVERNANCE}); 1.1 is the newer final track, also supported. JWS-signed Agent Cards, multi-tenancy and long-running async tasks are the v7 complete surface.`,
    },
    {
      family: 'mcp',
      current: MCP_V7_CURRENT_VERSION,
      legacy: MCP_V7_LEGACY_VERSIONS,
      removed: [],
      removalDate: MCP_V7_LEGACY_REMOVAL_DATE,
      note: `Stateless HTTP (spec 2026-07-28): no handshake, no session id, every request self-describing. Session-only methods (initialize) are refused on the stateless transport.`,
    },
    {
      family: 'ucp',
      current: UCP_V7_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: UCP_V7_REFUSAL_NOTE,
    },
    {
      family: 'acp',
      current: '',
      legacy: [],
      removed: [],
      removalDate: ACP_V7_MERGE_DATE,
      note: ACP_V7_NOTE,
    },
    {
      family: 'gov',
      current: GOV_V7_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: GOV_V7_NOTE,
    },
    {
      family: 'agui',
      current: AGUI_V7_CURRENT_VERSION,
      legacy: AGUI_V7_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '1.0 freezes 31 event types; THINKING_* removed, use REASONING_*.',
    },
    {
      family: 'a2ui',
      current: A2UI_V7_CURRENT_VERSION,
      legacy: A2UI_V7_LEGACY_VERSIONS,
      removed: [],
      removalDate: '',
      note: '',
    },
    {
      family: 'poppy',
      current: POPPY_V7_CURRENT_VERSION,
      legacy: [],
      removed: [],
      removalDate: '',
      note: POPPY_V7_IMPLEMENTATION_NOTE,
    },
  ];
}

/** One-line summary of the v7 matrix, for logs and the UI. */
export function protocolV7MatrixSummary(): string {
  return PROTOCOL_V7_FAMILIES.map(
    (f) => `${f} ${PROTOCOL_V7_CURRENT_VERSIONS[f] || 'merged'}`,
  ).join(' · ');
}

/**
 * What changed between the v6 and v7 matrices (for the changelog
 * and the UI).
 */
export function protocolV7ChangesSinceV6(): string[] {
  return [
    'A2A 1.0.1 is the implemented stable track: complete client/server (JWS-signed Agent Card, multi-tenancy, long-running async task lifecycle with push notifications). A2A 1.1 stays supported as the newer final track.',
    'MCP stateless HTTP (spec 2026-07-28): no handshake, no session id; every request self-describing and routable to any instance.',
    'UCP 2026-08-25 added as read-only: catalog / cart / order lookup only — checkout, payment and order placement are refused by construction.',
    'ACP is retired to "merged into A2A" (08/2025): v7 opens no ACP session and negotiates no ACP version.',
    'Governance 1.0 (open-bot layer): delegation with revocation + escalation to the user, constraints, hash-chained audit log — the layer all five surveyed protocols lack.',
    'Poppy 1.0: still watch-only, not implemented.',
  ];
}

/** True when the family/version pair may be used on the v7 surface. */
export function protocolV7IsUsable(family: ProtocolV7Family, version: string): boolean {
  return protocolV7IsImplemented(family, version);
}
