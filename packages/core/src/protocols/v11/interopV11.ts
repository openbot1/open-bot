/**
 * Protocols v11 — legacy interop: handshake fallback (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): a 2026-07-28 client
 * falls back to the `initialize` handshake when it meets a
 * server at 2025-11-25 or older. The fallback is explicit,
 * logged, and capability-downgraded: a legacy server gets no
 * multi round-trip, no Tasks extension and no Apps extension
 * — the client drives it with single-round calls only. No
 * code, text or asset from any other repo is copied here. No
 * network is opened by this module: the transport is
 * host-supplied; tests use the in-process legacy simulator
 * at the bottom of this file.
 *
 * What this module owns:
 *  - `negotiateMcpV11Interop()`: (client version, server
 *    version) -> mode + handshake requirement + downgraded
 *    capabilities + warnings.
 *  - `mcpV11InteropMatrixTable()`: the full client/server
 *    matrix as plain rows (for the versions tool + UI).
 *  - `McpV11LegacyClient`: the handshake client. It sends
 *    `initialize` (protocol version + capabilities +
 *    client info), stores the session id the server returns,
 *    sends `notifications/initialized`, then calls tools
 *    with the session id on every request. Session ids live
 *    ONLY on this legacy path — the stateless client never
 *    sees one.
 *  - `McpV11LegacyServerSimulator`: a minimal old-style
 *    server for tests — refuses every call until
 *    `initialize` has run, then answers `tools/list` /
 *    `tools/call` only when the session id matches.
 *  - `detectMcpV11ServerMode()`: classify a server from its
 *    discover answer (or its failure to answer discover).
 */

import {
  MCP_V11_CURRENT_VERSION,
  MCP_V11_LEGACY_CAPABILITIES,
  MCP_V11_LEGACY_VERSIONS,
  MCP_V11_VERSIONS,
  mcpV11CapabilitiesForServer,
  mcpV11InteropMode,
  mcpV11NeedsHandshake,
  type McpV11Capabilities,
  type McpV11InteropRow,
} from './versionsV11';

/** How a server was classified from its discover behaviour. */
export type McpV11ServerMode = 'stateless-2026-07-28' | 'legacy-handshake' | 'unknown';

/** Classify a server from a discover attempt. */
export function detectMcpV11ServerMode(input: {
  discoverOk: boolean;
  protocolVersion?: string;
  discoverErrorCode?: number;
}): McpV11ServerMode {
  if (input.discoverOk && input.protocolVersion === MCP_V11_CURRENT_VERSION) {
    return 'stateless-2026-07-28';
  }
  if (!input.discoverOk) {
    // A server that does not know server/discover at all (method
    // not found) is an old server: it only speaks initialize.
    if (input.discoverErrorCode === -32601) return 'legacy-handshake';
    return 'unknown';
  }
  if (input.protocolVersion && mcpV11NeedsHandshake(input.protocolVersion)) {
    return 'legacy-handshake';
  }
  return 'unknown';
}

/** Full negotiation outcome for one (client, server) pair. */
export interface McpV11InteropNegotiation extends McpV11InteropRow {
  /** Server versions the client can talk to at all. */
  supportedServerVersions: string[];
  /** Whether the client must warn the user about the downgrade. */
  downgradeWarning: boolean;
}

/** Negotiate one pair, with the supported-version list attached. */
export function negotiateMcpV11Interop(clientVersion: string, serverVersion: string): McpV11InteropNegotiation {
  const row = mcpV11InteropMode(clientVersion, serverVersion);
  return {
    ...row,
    supportedServerVersions: [...MCP_V11_VERSIONS],
    downgradeWarning: row.mode === 'handshake-fallback',
  };
}

/** The full matrix as plain rows (every client version x every server version). */
export function mcpV11InteropMatrixTable(): McpV11InteropRow[] {
  const rows: McpV11InteropRow[] = [];
  for (const clientVersion of MCP_V11_VERSIONS) {
    for (const serverVersion of MCP_V11_VERSIONS) {
      rows.push(mcpV11InteropMode(clientVersion, serverVersion));
    }
  }
  return rows;
}

/** One-line summary of the legacy surface (for logs). */
export function mcpV11LegacySummary(): string {
  return (
    `Legacy MCP versions (${MCP_V11_LEGACY_VERSIONS.join(', ')}) require the initialize handshake. ` +
    `On those servers the client downgrades to single-round calls only: no multi round-trip, no Tasks extension, no Apps extension.`
  );
}

/** JSON-RPC shapes reused by the legacy client + simulator. */
export interface McpV11LegacyJsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

export interface McpV11LegacyJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpV11LegacyTransport {
  request(
    request: McpV11LegacyJsonRpcRequest,
    headers?: Record<string, string>,
  ): Promise<McpV11LegacyJsonRpcResponse>;
}

/** Capabilities the legacy client advertises in `initialize`. */
export interface McpV11LegacyClientCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
}

/**
 * The handshake client, for old servers only. The session id
 * is stored on this instance and sent on every post-handshake
 * request; it never leaks into the stateless client.
 */
export class McpV11LegacyClient {
  private idCounter = 1;
  private sessionId: string | null = null;
  private serverInfo: { name: string; version: string } | null = null;
  private negotiatedVersion: string | null = null;

  constructor(
    private readonly transport: McpV11LegacyTransport,
    private readonly opts: {
      clientInfo?: { name: string; version: string };
      capabilities?: McpV11LegacyClientCapabilities;
      onDeprecatedUse?: (message: string) => void;
    } = {},
  ) {}

  /** The session id, once the handshake has run (null before). */
  get session(): string | null {
    return this.sessionId;
  }

  get server(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  /** Effective capabilities on the legacy path (everything v11 is off). */
  get effectiveCapabilities(): McpV11Capabilities {
    return { ...MCP_V11_LEGACY_CAPABILITIES };
  }

  private warn(message: string): void {
    this.opts.onDeprecatedUse?.(message);
  }

  /**
   * Run the `initialize` handshake against an old server.
   * `serverVersion` is the version the server claims (from a
   * failed discover, a well-known document, or user config).
   */
  async initialize(serverVersion: string): Promise<{ serverInfo: { name: string; version: string }; protocolVersion: string }> {
    if (!mcpV11NeedsHandshake(serverVersion)) {
      throw new Error(
        `Server ${serverVersion} speaks stateless MCP 2.0 — use the stateless client, not the handshake fallback.`,
      );
    }
    this.warn(
      `Handshake fallback: server ${serverVersion} predates stateless MCP; ` +
        `running initialize + session id. Multi round-trip, Tasks and Apps extensions are unavailable.`,
    );
    const response = await this.transport.request({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: serverVersion,
        capabilities: this.opts.capabilities ?? { tools: true },
        clientInfo: this.opts.clientInfo ?? { name: 'open-bot', version: '1.42.0' },
      },
      id: this.idCounter++,
    });
    if (response.error) {
      throw new Error(`Legacy initialize failed: ${response.error.message}`);
    }
    const result = (response.result ?? {}) as Record<string, unknown>;
    const serverInfo = result.serverInfo as { name: string; version: string } | undefined;
    if (!serverInfo || typeof serverInfo.name !== 'string') {
      throw new Error('Legacy initialize returned no serverInfo.');
    }
    const sessionId = result.sessionId as string | undefined;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Legacy initialize returned no session id.');
    }
    this.sessionId = sessionId;
    this.serverInfo = serverInfo;
    this.negotiatedVersion = String(result.protocolVersion ?? serverVersion);
    // Tell the server the client is ready (fire-and-forget notification).
    await this.transport.request({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
      id: this.idCounter++,
    });
    return { serverInfo, protocolVersion: this.negotiatedVersion };
  }

  private ensureSession(): void {
    if (!this.sessionId) throw new Error('Legacy client has no session: call initialize() first.');
  }

  /** List tools on the legacy server (single round, no caching). */
  async listTools(): Promise<string[]> {
    this.ensureSession();
    const response = await this.transport.request(
      { jsonrpc: '2.0', method: 'tools/list', params: {}, id: this.idCounter++ },
      { 'mcp-session-id': this.sessionId as string },
    );
    if (response.error) throw new Error(`Legacy tools/list failed: ${response.error.message}`);
    const tools = (response.result as Record<string, unknown>).tools as Array<{ name: string }> | undefined;
    return (tools ?? []).map((t) => t.name);
  }

  /** Call one tool on the legacy server (single round only — no MRTR). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.ensureSession();
    const response = await this.transport.request(
      { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: this.idCounter++ },
      { 'mcp-session-id': this.sessionId as string },
    );
    if (response.error) throw new Error(`Legacy tools/call failed: ${response.error.message}`);
    return (response.result ?? {}) as Record<string, unknown>;
  }
}

/**
 * Minimal old-style server for tests: it refuses everything
 * until `initialize` runs, then answers `tools/list` and
 * `tools/call` only when the session id matches. It never
 * answers `server/discover` (old servers do not know it).
 */
export class McpV11LegacyServerSimulator {
  private sessionId: string | null = null;
  private initialized = false;
  readonly version: string;
  private tools = new Map<string, (args: Record<string, unknown>) => Record<string, unknown>>();

  constructor(version = '2025-11-25') {
    this.version = version;
    this.tools.set('echo', (args) => ({ echoed: args }));
    this.tools.set('add', (args) => ({
      sum: (typeof args.a === 'number' ? args.a : 0) + (typeof args.b === 'number' ? args.b : 0),
    }));
  }

  async dispatch(
    request: McpV11LegacyJsonRpcRequest,
    headers: Record<string, string> = {},
  ): Promise<McpV11LegacyJsonRpcResponse> {
    const fail = (code: number, message: string): McpV11LegacyJsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code, message },
    });
    if (request.method === 'server/discover') {
      return fail(-32601, 'Method "server/discover" is not served by this server.');
    }
    if (request.method === 'initialize') {
      this.sessionId = `legacy-session-${this.version}`;
      this.initialized = true;
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: this.version,
          serverInfo: { name: 'legacy-mcp-server', version: this.version },
          sessionId: this.sessionId,
          capabilities: { tools: true },
        },
      };
    }
    if (!this.initialized || !this.sessionId) {
      return fail(-32000, 'No session: call initialize first.');
    }
    if (headers['mcp-session-id'] !== this.sessionId) {
      return fail(-32000, 'Missing or wrong Mcp-Session-Id header.');
    }
    if (request.method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id: request.id, result: {} };
    }
    if (request.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: [...this.tools.keys()].map((name) => ({ name })) },
      };
    }
    if (request.method === 'tools/call') {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const handler = this.tools.get(String(params.name ?? ''));
      if (!handler) return fail(-32602, `Unknown tool "${String(params.name ?? '')}".`);
      return { jsonrpc: '2.0', id: request.id, result: handler((params.arguments ?? {}) as Record<string, unknown>) };
    }
    return fail(-32601, `Method "${request.method}" is not served by this server.`);
  }

  /** In-process transport for the simulator. */
  sender(): McpV11LegacyTransport {
    return {
      request: (request, headers = {}) => this.dispatch(request, headers),
    };
  }
}

/** Capabilities a server version can honour (re-exported helper for the tools layer). */
export function mcpV11ServerCapabilities(serverVersion: string): McpV11Capabilities {
  return mcpV11CapabilitiesForServer(serverVersion);
}
