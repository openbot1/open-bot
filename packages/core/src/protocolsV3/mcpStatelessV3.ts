/**
 * Protocols v3 — MCP 2026-07-28 stateless core migration (v1.19, Team T3).
 *
 * Idea only, learned from the public MCP spec 2026-07-28 description
 * in docs/repo-survey-v119.md section 2: the core is stateless (no
 * `initialize` handshake), negotiation happens per request through
 * `_meta` + the `MCP-Protocol-Version` header, `server/discover`
 * replaces the handshake, Sampling / Roots / Logging are deprecated,
 * and Tasks / MCP Apps / Skills-over-MCP are extensions. No code,
 * text or asset from any other repo is copied here.
 *
 * This builds on the existing stateless layers without touching them:
 *  - `mcp/stateless.ts` — `_meta` envelope, `server/discover`,
 *    version negotiation against the 2025 list;
 *  - `mcp/deprecation.ts` — the deprecated-method table + shim;
 *  - `protocolsV2/mcpStatelessV117.ts` — the v117 stateless client.
 * v3 is the migration layer on top: it finishes the move from
 * "stateless as an option" to "stateless as the default" by adding
 *   1. header negotiation — parse/validate the `MCP-Protocol-Version`
 *      request header and the server's response header, with a
 *      strict mode that refuses a version mismatch instead of
 *      silently degrading;
 *   2. an extension registry — Tasks / Apps / Skills / Elicitation
 *      are registered as extensions with a minimum core version and
 *      a capability key; a request that needs an extension the peer
 *      did not negotiate is refused locally with a clear error
 *      instead of failing remotely with `-32601`;
 *   3. a deprecated-feature gate — Sampling / Roots / Logging calls
 *      are checked against a policy (`allow` | `warn` | `block`);
 *      `warn` records a notice the UI can show, `block` refuses
 *      before any network call;
 *   4. a migration advisor — given a legacy server's capabilities
 *      it produces a readiness report (what already works stateless,
 *      what needs the compat shim, what must be replaced) so the
 *      Settings UI can tell the user exactly what to do.
 *
 * Security: `_meta` and headers never carry credentials. The gate
 * runs before the transport is touched, so a blocked deprecated call
 * never reaches the server. Nothing here logs headers or tokens.
 */

import {
  MCP_PROTOCOL_VERSION_2026,
  buildStatelessMeta,
  isKnownProtocolVersion,
  negotiateStatelessVersion,
  parseStatelessMeta,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
  type StatelessRequestMeta,
} from '../mcp/stateless';
import {
  DEPRECATED_MCP_METHODS,
  isDeprecatedMcpMethod,
  type DeprecatedMcpMethod,
} from '../mcp/deprecation';
import {
  MCP_V3_EXTENSION_IDS,
  isKnownMcpV3Extension,
  type McpV3ExtensionId,
} from './versions';

/** Header name carrying the per-request protocol version. */
export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
/** Header name the old session transport used (must be absent in v3). */
export const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';

/** Error raised by the v3 stateless migration layer. */
export class McpStatelessV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpStatelessV3Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 1. Header negotiation
// ---------------------------------------------------------------------------

/** Outcome of parsing one `MCP-Protocol-Version` header value. */
export interface ProtocolVersionHeader {
  /** Raw header value (trimmed). */
  raw: string;
  /** Parsed version when the value is a known MCP date version. */
  version: string | null;
  /** True when the value is a version this build speaks. */
  known: boolean;
}

/** Parse the `MCP-Protocol-Version` header (case-insensitive lookup). */
export function parseProtocolVersionHeader(
  headers: Record<string, string | string[] | undefined>,
): ProtocolVersionHeader | null {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === MCP_PROTOCOL_VERSION_HEADER.toLowerCase(),
  );
  if (!entry) return null;
  const rawValue = entry[1];
  const raw = (Array.isArray(rawValue) ? rawValue[0] : rawValue ?? '').trim();
  if (raw === '') return { raw, version: null, known: false };
  const known = isKnownProtocolVersion(raw);
  return { raw, version: known ? raw : null, known };
}

/** Build the request headers for one stateless request. */
export function buildStatelessRequestHeaders(
  version: string = MCP_PROTOCOL_VERSION_2026,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { [MCP_PROTOCOL_VERSION_HEADER]: version, ...extra };
}

/** True when a header map still carries the old session header. */
export function hasLegacySessionHeader(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === MCP_SESSION_ID_HEADER.toLowerCase(),
  );
}

/** Header negotiation outcome for one request/response pair. */
export interface HeaderNegotiation {
  /** Version the client asked for. */
  requested: string;
  /** Version the server answered with (null when it sent no header). */
  responded: string | null;
  /** True when both sides agree (or the server sent no header). */
  agreed: boolean;
  /** Best shared version (falls back to the requested one). */
  negotiated: string;
  /** Human-readable note for the log / UI. */
  note: string;
}

/**
 * Negotiate the protocol version from the request/response headers.
 * Strict mode refuses a mismatch (server answered a different known
 * version) instead of degrading silently; lenient mode records the
 * mismatch and keeps the negotiated version.
 */
export function negotiateProtocolVersionHeaders(
  requested: string,
  responseHeaders: Record<string, string | string[] | undefined>,
  options: { strict?: boolean } = {},
): HeaderNegotiation {
  const parsed = parseProtocolVersionHeader(responseHeaders);
  const responded = parsed?.version ?? null;
  if (responded === null) {
    return {
      requested,
      responded: null,
      agreed: true,
      negotiated: requested,
      note: 'Server sent no MCP-Protocol-Version header; keeping the requested version.',
    };
  }
  const agreed = responded === requested;
  if (!agreed && options.strict) {
    throw new McpStatelessV3Error(
      'VERSION_MISMATCH',
      `Server answered protocol version ${responded} but the request asked for ${requested} (strict mode)`,
    );
  }
  const negotiated = negotiateStatelessVersion(responded, [responded], requested);
  return {
    requested,
    responded,
    agreed,
    negotiated,
    note: agreed
      ? `Both sides speak ${requested}.`
      : `Version mismatch: requested ${requested}, server answered ${responded}; negotiated ${negotiated}.`,
  };
}

// ---------------------------------------------------------------------------
// 2. Per-request negotiation (header + _meta together)
// ---------------------------------------------------------------------------

/** Everything one stateless request carries for negotiation. */
export interface StatelessRequestNegotiation {
  /** Protocol version for this request. */
  protocolVersion: string;
  /** Request headers (includes MCP-Protocol-Version). */
  headers: Record<string, string>;
  /** `_meta` envelope to attach to the JSON-RPC params. */
  meta: StatelessRequestMeta;
  /** Extensions the request needs (already checked against the peer). */
  extensions: string[];
}

/** Options for building one negotiated stateless request. */
export interface BuildStatelessRequestOptions {
  protocolVersion?: string;
  capabilities?: StatelessClientCapabilities;
  clientInfo?: { name: string; version: string };
  roundTrip?: StatelessRequestMeta['roundTrip'];
  task?: StatelessRequestMeta['task'];
  /** Extra request headers (never a session header — refused). */
  extraHeaders?: Record<string, string>;
  /** Extensions this request needs; checked by the caller via the registry. */
  extensions?: string[];
}

/**
 * Build one fully negotiated stateless request: `_meta` envelope +
 * headers. Refuses a legacy session header in `extraHeaders` and
 * refuses an unknown protocol version, so a misconfigured caller
 * fails locally instead of sending a malformed request.
 */
export function buildNegotiatedStatelessRequest(
  options: BuildStatelessRequestOptions = {},
): StatelessRequestNegotiation {
  const version = options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026;
  if (!isKnownProtocolVersion(version)) {
    throw new McpStatelessV3Error(
      'UNKNOWN_VERSION',
      `Unknown MCP protocol version: ${version}`,
    );
  }
  if (options.extraHeaders && hasLegacySessionHeader(options.extraHeaders)) {
    throw new McpStatelessV3Error(
      'LEGACY_SESSION_HEADER',
      `Stateless requests must not carry a ${MCP_SESSION_ID_HEADER} header`,
    );
  }
  const meta = buildStatelessMeta({
    protocolVersion: version,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
    roundTrip: options.roundTrip,
    task: options.task,
  });
  return {
    protocolVersion: version,
    headers: buildStatelessRequestHeaders(version, options.extraHeaders ?? {}),
    meta,
    extensions: [...(options.extensions ?? [])],
  };
}

/** Validate a `_meta` envelope received by a server (v3 wrapper). */
export function validateIncomingStatelessMeta(
  value: unknown,
): { ok: true; meta: StatelessRequestMeta } | { ok: false; reason: string } {
  const meta = parseStatelessMeta(value);
  if (meta === null) {
    return { ok: false, reason: 'Missing or malformed _meta envelope (stateless request required)' };
  }
  if (!isKnownProtocolVersion(meta.protocolVersion)) {
    return { ok: false, reason: `Unknown protocol version in _meta: ${meta.protocolVersion}` };
  }
  return { ok: true, meta };
}

// ---------------------------------------------------------------------------
// 3. Extension registry (Tasks / Apps / Skills / Elicitation)
// ---------------------------------------------------------------------------

/** One registered MCP extension. */
export interface McpV3Extension {
  /** Extension identifier, e.g. `io.modelcontextprotocol/tasks`. */
  id: string;
  /** Minimum core version the extension needs. */
  minCoreVersion: string;
  /** Capability key the extension enables in `server/discover`. */
  capabilityKey: 'tasks' | 'apps' | 'skills' | 'elicitation';
  /** Methods the extension adds. */
  methods: string[];
  /** Short description (UI). */
  description: string;
}

/** Default v3 extension set (the four extensions of spec 2026-07-28). */
export function defaultMcpV3Extensions(): McpV3Extension[] {
  return [
    {
      id: MCP_V3_EXTENSION_IDS.tasks,
      minCoreVersion: MCP_PROTOCOL_VERSION_2026,
      capabilityKey: 'tasks',
      methods: ['tasks/create', 'tasks/get', 'tasks/list', 'tasks/cancel', 'tasks/result'],
      description: 'Long-running task handles with polling and results.',
    },
    {
      id: MCP_V3_EXTENSION_IDS.apps,
      minCoreVersion: MCP_PROTOCOL_VERSION_2026,
      capabilityKey: 'apps',
      methods: ['apps/list', 'apps/get', 'apps/render'],
      description: 'Sandboxed MCP Apps (interactive UI served by the server).',
    },
    {
      id: MCP_V3_EXTENSION_IDS.skills,
      minCoreVersion: MCP_PROTOCOL_VERSION_2026,
      capabilityKey: 'skills',
      methods: ['skills/list', 'skills/get'],
      description: 'Agent Skills served over MCP (SEP-2640).',
    },
    {
      id: MCP_V3_EXTENSION_IDS.elicitation,
      minCoreVersion: MCP_PROTOCOL_VERSION_2026,
      capabilityKey: 'elicitation',
      methods: ['elicitation/create'],
      description: 'Server asks the user for a value mid-call.',
    },
  ];
}

/** Registry of negotiated extensions for one peer. */
export class McpV3ExtensionRegistry {
  private readonly byId = new Map<string, McpV3Extension>();
  private readonly negotiated = new Set<string>();

  constructor(extensions: McpV3Extension[] = defaultMcpV3Extensions()) {
    for (const ext of extensions) this.byId.set(ext.id, ext);
  }

  /** Register (or replace) an extension definition. */
  register(extension: McpV3Extension): void {
    this.byId.set(extension.id, extension);
  }

  /** All registered extension definitions. */
  list(): McpV3Extension[] {
    return [...this.byId.values()];
  }

  /** One extension definition, or null. */
  get(id: string): McpV3Extension | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Negotiate extensions from a `server/discover` result: an
   * extension is negotiated when the server lists its id AND
   * advertises its capability key. Unknown ids are ignored.
   * Returns the negotiated ids.
   */
  negotiateFromDiscover(discover: ServerDiscoverResult): string[] {
    this.negotiated.clear();
    const listed = new Set(discover.extensions ?? []);
    for (const ext of this.byId.values()) {
      const capability = (discover.capabilities as Record<string, unknown>)[ext.capabilityKey];
      if (listed.has(ext.id) && capability !== undefined && capability !== null) {
        this.negotiated.add(ext.id);
      }
    }
    return this.negotiatedIds();
  }

  /** Negotiated extension ids. */
  negotiatedIds(): string[] {
    return [...this.negotiated];
  }

  /** True when the extension was negotiated with this peer. */
  isNegotiated(id: string): boolean {
    return this.negotiated.has(id);
  }

  /** Extension that owns a method, or null when no extension does. */
  extensionForMethod(method: string): McpV3Extension | null {
    for (const ext of this.byId.values()) {
      if (ext.methods.includes(method)) return ext;
    }
    return null;
  }

  /**
   * Refuse locally when a method needs an extension that was not
   * negotiated. Returns null when the call may proceed.
   */
  checkMethod(method: string): { ok: true } | { ok: false; reason: string } {
    const ext = this.extensionForMethod(method);
    if (!ext) return { ok: true };
    if (!this.isNegotiated(ext.id)) {
      return {
        ok: false,
        reason: `Method ${method} needs extension ${ext.id} (${ext.description}) which was not negotiated with this server`,
      };
    }
    return { ok: true };
  }

  /** True when the id is a known v3 extension (registered or builtin). */
  isKnownExtension(id: string): boolean {
    return this.byId.has(id) || isKnownMcpV3Extension(id as McpV3ExtensionId);
  }
}

// ---------------------------------------------------------------------------
// 4. Deprecated-feature gate (Sampling / Roots / Logging)
// ---------------------------------------------------------------------------

/** Policy for a deprecated MCP feature. */
export type DeprecatedFeaturePolicy = 'allow' | 'warn' | 'block';

/** Gate options: one policy per deprecated area (default: warn). */
export interface DeprecatedFeatureGateOptions {
  sampling?: DeprecatedFeaturePolicy;
  roots?: DeprecatedFeaturePolicy;
  logging?: DeprecatedFeaturePolicy;
  /** Unknown deprecated methods (not in the table) use this policy. */
  fallback?: DeprecatedFeaturePolicy;
}

/** One recorded deprecated-feature use (for the audit log / UI). */
export interface DeprecatedFeatureNotice {
  method: string;
  area: 'sampling' | 'roots' | 'logging' | 'other';
  policy: DeprecatedFeaturePolicy;
  at: string;
  detail: string;
}

/** Which area a deprecated method belongs to. */
export function deprecatedMethodArea(
  method: DeprecatedMcpMethod,
): 'sampling' | 'roots' | 'logging' | 'other' {
  const m = method.method;
  if (m.startsWith('sampling/')) return 'sampling';
  if (m.startsWith('roots/')) return 'roots';
  if (m.startsWith('logging/')) return 'logging';
  return 'other';
}

/**
 * Gate for deprecated MCP features. Sampling / Roots / Logging are
 * deprecated in spec 2026-07-28; the gate lets the user choose per
 * area whether to keep using them (`allow`), use them with a visible
 * notice (`warn`, the default), or refuse them outright (`block`).
 * Blocked calls never reach the transport.
 */
export class DeprecatedFeatureGate {
  private readonly policies: Required<DeprecatedFeatureGateOptions>;
  private readonly notices: DeprecatedFeatureNotice[] = [];

  constructor(options: DeprecatedFeatureGateOptions = {}) {
    this.policies = {
      sampling: options.sampling ?? 'warn',
      roots: options.roots ?? 'warn',
      logging: options.logging ?? 'warn',
      fallback: options.fallback ?? 'warn',
    };
  }

  /** Current policy for one area. */
  policyFor(area: 'sampling' | 'roots' | 'logging' | 'other'): DeprecatedFeaturePolicy {
    // 'other' has no per-area policy: it always uses the fallback.
    if (area === 'other') return this.policies.fallback;
    return this.policies[area];
  }

  /** Change the policy for one area at runtime (Settings UI). */
  setPolicy(area: 'sampling' | 'roots' | 'logging', policy: DeprecatedFeaturePolicy): void {
    this.policies[area] = policy;
  }

  /** All recorded notices (newest last). */
  getNotices(): DeprecatedFeatureNotice[] {
    return [...this.notices];
  }

  /** Clear recorded notices. */
  clearNotices(): void {
    this.notices.length = 0;
  }

  /**
   * Check a method before it is sent. Returns `{ ok: true }` when
   * the call may proceed (recording a notice under `warn`), or
   * `{ ok: false, reason }` when the policy blocks it.
   */
  check(method: string): { ok: true; notice?: DeprecatedFeatureNotice } | { ok: false; reason: string } {
    if (!isDeprecatedMcpMethod(method)) return { ok: true };
    const meta = DEPRECATED_MCP_METHODS.find((d) => d.method === method);
    const area = meta ? deprecatedMethodArea(meta) : 'other';
    const policy = this.policyFor(area);
    if (policy === 'block') {
      return {
        ok: false,
        reason: `Deprecated MCP method ${method} is blocked by policy (deprecated since 2026-07-28, removal ${meta?.removeAfter ?? '2027-07-28'})`,
      };
    }
    if (policy === 'warn') {
      const notice: DeprecatedFeatureNotice = {
        method,
        area,
        policy,
        at: new Date().toISOString(),
        detail: meta
          ? `${meta.method} is deprecated: ${meta.reason ?? meta.replacement ?? 'use the stateless core instead'}`
          : `${method} is deprecated`,
      };
      this.notices.push(notice);
      return { ok: true, notice };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// 5. Migration advisor
// ---------------------------------------------------------------------------

/** One item of a migration readiness report. */
export interface MigrationAdvisorItem {
  area: string;
  status: 'ready' | 'needs-shim' | 'must-replace' | 'info';
  detail: string;
}

/** Readiness report for one legacy server. */
export interface MigrationReadinessReport {
  serverName: string;
  serverVersion: string;
  /** Protocol version the client would speak to this server. */
  negotiatedVersion: string;
  /** True when the server can work fully stateless. */
  statelessReady: boolean;
  items: MigrationAdvisorItem[];
  /** Suggested next steps, in order. */
  nextSteps: string[];
}

/**
 * Assess a legacy (pre-2026-07-28) server's capabilities and produce
 * a readiness report: what already works stateless, what needs the
 * compat shim, and what must be replaced. Pure function — no I/O.
 */
export function assessStatelessReadiness(
  serverName: string,
  serverVersion: string,
  capabilities: {
    tools?: unknown;
    resources?: unknown;
    prompts?: unknown;
    sampling?: unknown;
    roots?: unknown;
    logging?: unknown;
    experimental?: Record<string, unknown>;
  },
  discover: ServerDiscoverResult | null = null,
): MigrationReadinessReport {
  const items: MigrationAdvisorItem[] = [];
  const nextSteps: string[] = [];
  const negotiatedVersion = negotiateStatelessVersion(
    serverVersion,
    discover?.supportedVersions,
  );

  // The verdict must use what the SERVER speaks, not the negotiated
  // fallback: negotiateStatelessVersion degrades to the client's
  // preferred version on no overlap, so a 2025-03-26 server would
  // otherwise be misreported as speaking 2026-07-28.
  const statelessCore =
    serverVersion === MCP_PROTOCOL_VERSION_2026
    || (discover?.supportedVersions ?? []).includes(MCP_PROTOCOL_VERSION_2026);
  items.push({
    area: 'stateless-core',
    status: statelessCore ? 'ready' : 'needs-shim',
    detail: statelessCore
      ? `Server speaks ${MCP_PROTOCOL_VERSION_2026}; per-request negotiation works.`
      : `Server speaks ${serverVersion}; the initialize handshake + session shim stays enabled for this server.`,
  });
  if (!statelessCore) {
    nextSteps.push(`Keep the legacy handshake shim enabled for ${serverName} until it upgrades to ${MCP_PROTOCOL_VERSION_2026}.`);
  }

  if (discover) {
    items.push({
      area: 'server/discover',
      status: 'ready',
      detail: `server/discover answered with protocol ${discover.protocolVersion}.`,
    });
  } else {
    items.push({
      area: 'server/discover',
      status: 'needs-shim',
      detail: 'Server does not answer server/discover; the client falls back to the initialize handshake.',
    });
    nextSteps.push(`Ask the server maintainer to implement server/discover (MCP 2026-07-28).`);
  }

  for (const area of ['tools', 'resources', 'prompts'] as const) {
    const present = capabilities[area] !== undefined && capabilities[area] !== null;
    items.push({
      area,
      status: present ? 'ready' : 'info',
      detail: present ? `${area} capability advertised; works stateless.` : `${area} capability not advertised.`,
    });
  }

  for (const area of ['sampling', 'roots', 'logging'] as const) {
    const present = capabilities[area] !== undefined && capabilities[area] !== null;
    if (!present) continue;
    items.push({
      area,
      status: 'must-replace',
      detail: `${area} is deprecated in MCP 2026-07-28 (removal 2027-07-28). Replace with the stateless equivalent or drop it.`,
    });
    nextSteps.push(
      area === 'sampling'
        ? 'Replace sampling/ calls with a local model call or an MRTR needs_sampling round.'
        : area === 'roots'
          ? 'Replace roots/ calls with explicit workspace paths in tool arguments.'
          : 'Replace logging/ calls with the local audit log.',
    );
  }

  const extensions = discover?.extensions ?? [];
  if (extensions.length > 0) {
    items.push({
      area: 'extensions',
      status: 'ready',
      detail: `Server lists extensions: ${extensions.join(', ')}.`,
    });
  } else {
    items.push({
      area: 'extensions',
      status: 'info',
      detail: 'Server lists no extensions; Tasks / Apps / Skills are unavailable on this server.',
    });
  }

  const statelessReady =
    statelessCore && discover !== null && !['sampling', 'roots', 'logging'].some(
      (area) => capabilities[area as 'sampling' | 'roots' | 'logging'] !== undefined
        && capabilities[area as 'sampling' | 'roots' | 'logging'] !== null,
    );
  return { serverName, serverVersion, negotiatedVersion, statelessReady, items, nextSteps };
}
