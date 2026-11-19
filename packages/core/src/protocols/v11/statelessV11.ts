/**
 * Protocols v11 — MCP 2.0 stateless core (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): the core is fully
 * stateless — no `initialize` handshake, no `Mcp-Session-Id`;
 * every request carries the protocol version and the client
 * capabilities in `_meta`; `server/discover` is the entry
 * point; routing headers steer a request behind one endpoint;
 * lists are cacheable. No code, text or asset from any other
 * repo is copied here. No network is opened by this module:
 * the HTTP sender is host-supplied; tests use the in-process
 * loopback sender at the bottom of this file.
 *
 * What this module owns:
 *  - `_meta` construction + validation (version required,
 *    must be 2026-07-28; capabilities all boolean).
 *  - Routing headers (`mcp-routing-key`, `mcp-target-server`,
 *    `mcp-request-id`, `mcp-protocol-version`): build, parse
 *    and validate; a request without a request id gets one.
 *  - Cacheable lists: every list carries `listHash` (stable
 *    hash of the sorted entries) + `listVersion` (monotonic
 *    counter); a client that already holds the hash asks with
 *    `knownListHash` and gets `{ notModified: true }` instead
 *    of the full list. `McpV11ListCache` is the client-side
 *    half (TTL + staleness).
 *  - `McpV11StatelessServer`: in-process dispatch for
 *    `server/discover`, `tools/list`, `tools/call`,
 *    `resources/list`, `prompts/list`. Session-only methods
 *    (`initialize`, `notifications/initialized`) are REFUSED
 *    with a JSON-RPC error that names `server/discover`.
 *    A request carrying a `Mcp-Session-Id` header is refused:
 *    the stateless transport has no sessions to resume.
 *  - `McpV11StatelessClient`: discover-first, per-request
 *    `_meta`, routing headers on every call, list caching.
 *
 * Deprecated surface (roots / sampling / logging) is NOT
 * implemented here: a server method that would need a
 * mid-request callback is refused with `deprecated-callback`.
 */

import { randomUUID } from 'node:crypto';
import { McpV11AuditLog, mcpV11AuditTimer } from './auditV11';
import {
  MCP_V11_CURRENT_VERSION,
  MCP_V11_DISCOVER_METHOD,
  MCP_V11_EXTENSIONS,
  MCP_V11_SESSION_ID_HEADER,
  MCP_V11_SESSION_ONLY_METHODS,
  MCP_V11_UI_EXTENSION,
  MCP_V11_TASKS_EXTENSION,
  type McpV11Capabilities,
} from './versionsV11';

/** Error raised by the v11 MCP stateless layer. */
export class McpV11StatelessError extends Error {
  readonly code: string;
  /** JSON-RPC error code. */
  readonly rpcCode: number;
  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = 'McpV11StatelessError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** JSON-RPC error object. */
export interface McpV11JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** One JSON-RPC request the transport sends. */
export interface McpV11JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

/** One JSON-RPC response the transport receives. */
export interface McpV11JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: McpV11JsonRpcError;
}

/** Transport: send one JSON-RPC request, get one response. */
export interface McpV11Transport {
  request(
    request: McpV11JsonRpcRequest,
    headers?: Record<string, string>,
  ): Promise<McpV11JsonRpcResponse>;
}

/** The `_meta` every v11 request carries. */
export interface McpV11RequestMeta {
  protocolVersion: string;
  capabilities: McpV11Capabilities;
  /** Client identifier, e.g. `open-bot/1.42`. */
  clientInfo?: { name: string; version: string };
  /** OpenTelemetry trace id (32 hex chars) when tracing is on. */
  traceId?: string;
  /** Opaque routing key the server echoed from discover. */
  routingKey?: string;
}

/** Build a valid `_meta` for a v11 request. */
export function buildMcpV11RequestMeta(
  capabilities: Partial<McpV11Capabilities> = {},
  opts: { clientInfo?: { name: string; version: string }; traceId?: string; routingKey?: string } = {},
): McpV11RequestMeta {
  return {
    protocolVersion: MCP_V11_CURRENT_VERSION,
    capabilities: {
      multiRoundTrip: capabilities.multiRoundTrip ?? true,
      tasks: capabilities.tasks ?? true,
      apps: capabilities.apps ?? true,
      cacheableLists: capabilities.cacheableLists ?? true,
      routing: capabilities.routing ?? true,
    },
    ...(opts.clientInfo ? { clientInfo: opts.clientInfo } : {}),
    ...(opts.traceId ? { traceId: opts.traceId } : {}),
    ...(opts.routingKey ? { routingKey: opts.routingKey } : {}),
  };
}

/** Validate a `_meta` value. Returns the list of problems (empty = valid). */
export function validateMcpV11RequestMeta(meta: unknown): string[] {
  const problems: string[] = [];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return ['_meta must be an object.'];
  }
  const record = meta as Record<string, unknown>;
  if (record.protocolVersion === undefined) {
    problems.push('_meta.protocolVersion is required (MCP 2.0 carries the version on every request).');
  } else if (record.protocolVersion !== MCP_V11_CURRENT_VERSION) {
    problems.push(`_meta.protocolVersion must be "${MCP_V11_CURRENT_VERSION}", got "${String(record.protocolVersion)}".`);
  }
  if (record.capabilities === undefined) {
    problems.push('_meta.capabilities is required (MCP 2.0 carries capabilities on every request).');
  } else if (typeof record.capabilities !== 'object' || record.capabilities === null || Array.isArray(record.capabilities)) {
    problems.push('_meta.capabilities must be an object.');
  } else {
    const caps = record.capabilities as Record<string, unknown>;
    for (const key of ['multiRoundTrip', 'tasks', 'apps', 'cacheableLists', 'routing']) {
      if (caps[key] === undefined) problems.push(`_meta.capabilities.${key} is required.`);
      else if (typeof caps[key] !== 'boolean') problems.push(`_meta.capabilities.${key} must be a boolean.`);
    }
  }
  if (record.traceId !== undefined && (typeof record.traceId !== 'string' || !/^[0-9a-f]{32}$/.test(record.traceId))) {
    problems.push('_meta.traceId must be 32 lowercase hex chars.');
  }
  if (record.clientInfo !== undefined) {
    const info = record.clientInfo as Record<string, unknown>;
    if (typeof info !== 'object' || info === null || typeof info.name !== 'string' || typeof info.version !== 'string') {
      problems.push('_meta.clientInfo must be { name: string, version: string }.');
    }
  }
  return problems;
}

/** Routing headers carried alongside a v11 request. */
export interface McpV11RoutingHeaders {
  /** Which server behind the endpoint should handle this request. */
  routingKey?: string;
  /** Target server id or URL the client discovered. */
  targetServer?: string;
  /** Unique per-request id (the server echoes it in errors). */
  requestId: string;
  /** Protocol version, mirroring `_meta.protocolVersion`. */
  protocolVersion: string;
}

/** Header names (lowercase) used for routing. */
export const MCP_V11_ROUTING_HEADER_NAMES = [
  'mcp-routing-key',
  'mcp-target-server',
  'mcp-request-id',
  'mcp-protocol-version',
] as const;

/** Build routing headers for one request. */
export function buildMcpV11RoutingHeaders(opts: {
  routingKey?: string;
  targetServer?: string;
  requestId?: string;
}): McpV11RoutingHeaders {
  return {
    ...(opts.routingKey ? { routingKey: opts.routingKey } : {}),
    ...(opts.targetServer ? { targetServer: opts.targetServer } : {}),
    requestId: opts.requestId ?? randomUUID(),
    protocolVersion: MCP_V11_CURRENT_VERSION,
  };
}

/** Serialise routing headers to wire form (lowercase header names). */
export function mcpV11RoutingHeadersToWire(headers: McpV11RoutingHeaders): Record<string, string> {
  const wire: Record<string, string> = {
    'mcp-request-id': headers.requestId,
    'mcp-protocol-version': headers.protocolVersion,
  };
  if (headers.routingKey) wire['mcp-routing-key'] = headers.routingKey;
  if (headers.targetServer) wire['mcp-target-server'] = headers.targetServer;
  return wire;
}

/** Parse routing headers from wire form. Returns problems when invalid. */
export function parseMcpV11RoutingHeaders(
  wire: Record<string, string>,
): { headers: McpV11RoutingHeaders | null; problems: string[] } {
  const problems: string[] = [];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(wire)) lower[k.toLowerCase()] = v;
  const requestId = lower['mcp-request-id'];
  if (!requestId) problems.push('Missing routing header "mcp-request-id".');
  const protocolVersion = lower['mcp-protocol-version'];
  if (!protocolVersion) {
    problems.push('Missing routing header "mcp-protocol-version".');
  } else if (protocolVersion !== MCP_V11_CURRENT_VERSION) {
    problems.push(`Routing header "mcp-protocol-version" must be "${MCP_V11_CURRENT_VERSION}", got "${protocolVersion}".`);
  }
  if (problems.length > 0) return { headers: null, problems };
  return {
    headers: {
      ...(lower['mcp-routing-key'] ? { routingKey: lower['mcp-routing-key'] } : {}),
      ...(lower['mcp-target-server'] ? { targetServer: lower['mcp-target-server'] } : {}),
      requestId: requestId as string,
      protocolVersion: protocolVersion as string,
    },
    problems,
  };
}

/** One cacheable list entry (tool / resource / prompt descriptor). */
export interface McpV11ListEntry {
  name: string;
  description?: string;
  [key: string]: unknown;
}

/** A list answer: full entries, or a not-modified marker when the hash matches. */
export type McpV11ListResult =
  | { notModified: false; entries: McpV11ListEntry[]; listHash: string; listVersion: number }
  | { notModified: true; listHash: string; listVersion: number };

/** Stable hash of a sorted entry list (FNV-1a over the JSON, hex). */
export function hashMcpV11List(entries: McpV11ListEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const text = JSON.stringify(sorted.map((e) => ({ name: e.name, description: e.description ?? '' })));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Client-side cache for cacheable lists. */
export class McpV11ListCache {
  private entries = new Map<string, { listHash: string; listVersion: number; fetchedAtMs: number; entries: McpV11ListEntry[] }>();
  constructor(private readonly ttlMs: number = 60_000) {}

  get(kind: string): { hit: boolean; stale: boolean; entries?: McpV11ListEntry[]; listHash?: string; listVersion?: number } {
    const entry = this.entries.get(kind);
    if (!entry) return { hit: false, stale: false };
    const stale = Date.now() - entry.fetchedAtMs > this.ttlMs;
    return { hit: true, stale, entries: entry.entries, listHash: entry.listHash, listVersion: entry.listVersion };
  }

  put(kind: string, result: McpV11ListResult): void {
    if (result.notModified) return;
    this.entries.set(kind, { listHash: result.listHash, listVersion: result.listVersion, fetchedAtMs: Date.now(), entries: result.entries });
  }

  invalidate(kind?: string): void {
    if (kind) this.entries.delete(kind);
    else this.entries.clear();
  }

  kinds(): string[] {
    return [...this.entries.keys()].sort();
  }
}

/** Result of `server/discover`. */
export interface McpV11DiscoverResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  extensions: string[];
  capabilities: McpV11Capabilities;
  /** Routing table the server publishes (server id -> route key). */
  routing: Record<string, string>;
  /** Lists the server serves as cacheable. */
  cacheableLists: string[];
}

/** Validate a discover result. Returns problems (empty = valid). */
export function validateMcpV11DiscoverResult(result: unknown): string[] {
  const problems: string[] = [];
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return ['discover result must be an object.'];
  const r = result as Record<string, unknown>;
  if (r.protocolVersion !== MCP_V11_CURRENT_VERSION) {
    problems.push(`discover protocolVersion must be "${MCP_V11_CURRENT_VERSION}".`);
  }
  if (typeof r.serverInfo !== 'object' || r.serverInfo === null) {
    problems.push('discover serverInfo is required.');
  } else {
    const info = r.serverInfo as Record<string, unknown>;
    if (typeof info.name !== 'string' || !info.name) problems.push('discover serverInfo.name is required.');
    if (typeof info.version !== 'string' || !info.version) problems.push('discover serverInfo.version is required.');
  }
  if (!Array.isArray(r.extensions)) problems.push('discover extensions must be an array.');
  if (typeof r.routing !== 'object' || r.routing === null) problems.push('discover routing must be an object.');
  if (!Array.isArray(r.cacheableLists)) problems.push('discover cacheableLists must be an array.');
  return problems;
}

/** A tool a v11 server can run (handler returns a result or an input_required round). */
export interface McpV11ServerTool {
  name: string;
  description: string;
  /** Handler: (args, callCount) => result object. May return `{ resultType: 'input_required', ... }`. */
  handler: (args: Record<string, unknown>, callCount: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface McpV11StatelessServerOptions {
  name?: string;
  version?: string;
  tools?: McpV11ServerTool[];
  resources?: McpV11ListEntry[];
  prompts?: McpV11ListEntry[];
  /** Max audit entries kept (default 500). Pass 0 to disable the audit log. */
  auditMaxEntries?: number;
}

/**
 * In-process v11 stateless server. Holds no session state: the
 * only mutable state is the list version counters (which change
 * only when the tool/resource/prompt set changes) and the
 * call counters (observability, not session state).
 */
export class McpV11StatelessServer {
  readonly name: string;
  readonly version: string;
  private tools = new Map<string, McpV11ServerTool>();
  private resources: McpV11ListEntry[];
  private prompts: McpV11ListEntry[];
  private listVersions = { tools: 1, resources: 1, prompts: 1 };
  private callCounts = new Map<string, number>();
  totalCalls = 0;
  /** Per-request audit log (bounded ring buffer, no arguments stored). */
  readonly audit: McpV11AuditLog;

  constructor(opts: McpV11StatelessServerOptions = {}) {
    this.name = opts.name ?? 'open-bot-mcp-v11';
    this.version = opts.version ?? '1.42.0';
    this.audit = new McpV11AuditLog(opts.auditMaxEntries ?? 500);
    for (const tool of opts.tools ?? []) this.tools.set(tool.name, tool);
    this.resources = opts.resources ?? [];
    this.prompts = opts.prompts ?? [];
  }

  /** Register (or replace) a tool; bumps the tools list version. */
  registerTool(tool: McpV11ServerTool): void {
    this.tools.set(tool.name, tool);
    this.listVersions.tools += 1;
  }

  /** Remove a tool; bumps the tools list version. */
  removeTool(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.listVersions.tools += 1;
    return removed;
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  discoverResult(): McpV11DiscoverResult {
    return {
      protocolVersion: MCP_V11_CURRENT_VERSION,
      serverInfo: { name: this.name, version: this.version },
      extensions: [...MCP_V11_EXTENSIONS],
      capabilities: {
        multiRoundTrip: true,
        tasks: true,
        apps: true,
        cacheableLists: true,
        routing: true,
      },
      routing: { [this.name]: `route:${this.name}` },
      cacheableLists: ['tools', 'resources', 'prompts'],
    };
  }

  private listResult(kind: 'tools' | 'resources' | 'prompts', knownListHash?: string): McpV11ListResult {
    const entries: McpV11ListEntry[] =
      kind === 'tools'
        ? this.toolNames().map((name) => ({ name, description: this.tools.get(name)?.description ?? '' }))
        : kind === 'resources'
          ? [...this.resources].sort((a, b) => (a.name < b.name ? -1 : 1))
          : [...this.prompts].sort((a, b) => (a.name < b.name ? -1 : 1));
    const listHash = hashMcpV11List(entries);
    const listVersion = this.listVersions[kind];
    if (knownListHash !== undefined && knownListHash === listHash) {
      return { notModified: true, listHash, listVersion };
    }
    return { notModified: false, entries, listHash, listVersion };
  }

  /**
   * Dispatch one JSON-RPC request. `headers` is the wire headers
   * (lowercase keys). Every dispatch — including refusals — is
   * recorded in the audit log, keyed by the routing request id.
   */
  async dispatch(
    request: McpV11JsonRpcRequest,
    headers: Record<string, string> = {},
  ): Promise<McpV11JsonRpcResponse> {
    const startedAtMs = Date.now();
    const finish = mcpV11AuditTimer(
      this.audit,
      {
        requestId: headers['mcp-request-id'] ?? String(request.id ?? ''),
        method: request.method,
        ...(headers['mcp-routing-key'] ? { routingKey: headers['mcp-routing-key'] } : {}),
        server: this.name,
      },
      startedAtMs,
    );
    const response = await this.dispatchInner(request, headers);
    if (response.error) {
      const data = response.error.data as Record<string, unknown> | undefined;
      const code = typeof data?.code === 'string' ? data.code : String(response.error.code);
      const refused = ['session-only-method', 'deprecated-callback', 'invalid-meta', 'session-id-refused'].includes(code);
      finish(refused ? 'refused' : 'failed', code);
    } else {
      finish('ok');
    }
    return response;
  }

  private async dispatchInner(
    request: McpV11JsonRpcRequest,
    headers: Record<string, string> = {},
  ): Promise<McpV11JsonRpcResponse> {
    const fail = (code: number, message: string, data?: unknown): McpV11JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
    this.totalCalls += 1;

    // The stateless transport refuses session ids outright.
    if (headers[MCP_V11_SESSION_ID_HEADER] !== undefined) {
      return fail(-32000, 'Mcp-Session-Id is not accepted: this server is stateless (MCP 2026-07-28).', {
        code: 'session-id-refused',
        use: MCP_V11_DISCOVER_METHOD,
      });
    }

    const params = (request.params ?? {}) as Record<string, unknown>;
    const meta = params._meta;

    // Session-only methods are refused with a pointer to discover.
    if ((MCP_V11_SESSION_ONLY_METHODS as readonly string[]).includes(request.method)) {
      return fail(-32601, `Method "${request.method}" is session-only and is refused on the stateless core.`, {
        code: 'session-only-method',
        use: MCP_V11_DISCOVER_METHOD,
      });
    }
    // Mid-request callbacks are dead in MCP 2.0: refuse, do not emulate.
    if (request.method.startsWith('sampling/') || request.method.startsWith('roots/') || request.method.startsWith('logging/')) {
      return fail(-32601, `Method "${request.method}" is deprecated (roots/sampling/logging) and is not served by MCP 2.0.`, {
        code: 'deprecated-callback',
        deprecatedSince: '2026-07-28',
        earliestRemoval: '2027-07-28',
        replacedBy: 'multi round-trip requests (input_required)',
      });
    }

    if (request.method === MCP_V11_DISCOVER_METHOD) {
      return { jsonrpc: '2.0', id: request.id, result: this.discoverResult() as unknown as Record<string, unknown> };
    }

    // Every other method needs a valid _meta.
    const metaProblems = validateMcpV11RequestMeta(meta);
    if (metaProblems.length > 0) {
      return fail(-32602, 'Invalid _meta: ' + metaProblems.join(' '), { code: 'invalid-meta', problems: metaProblems });
    }

    switch (request.method) {
      case 'tools/list': {
        const known = typeof params.knownListHash === 'string' ? params.knownListHash : undefined;
        const result = this.listResult('tools', known);
        return { jsonrpc: '2.0', id: request.id, result: result as unknown as Record<string, unknown> };
      }
      case 'resources/list': {
        const known = typeof params.knownListHash === 'string' ? params.knownListHash : undefined;
        const result = this.listResult('resources', known);
        return { jsonrpc: '2.0', id: request.id, result: result as unknown as Record<string, unknown> };
      }
      case 'prompts/list': {
        const known = typeof params.knownListHash === 'string' ? params.knownListHash : undefined;
        const result = this.listResult('prompts', known);
        return { jsonrpc: '2.0', id: request.id, result: result as unknown as Record<string, unknown> };
      }
      case 'tools/call': {
        const toolName = params.name;
        if (typeof toolName !== 'string' || !this.tools.has(toolName)) {
          return fail(-32602, `Unknown tool "${String(toolName)}".`, { code: 'unknown-tool' });
        }
        const tool = this.tools.get(toolName) as McpV11ServerTool;
        const count = (this.callCounts.get(toolName) ?? 0) + 1;
        this.callCounts.set(toolName, count);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await tool.handler(args, count);
          return { jsonrpc: '2.0', id: request.id, result };
        } catch (err) {
          return fail(-32000, `Tool "${toolName}" failed: ${(err as Error).message}`, { code: 'tool-error' });
        }
      }
      default:
        return fail(-32601, `Method "${request.method}" is not served by this server.`, { code: 'method-not-found' });
    }
  }
}

/** Build an in-process transport that talks straight to a server (tests + local use). */
export function createLoopbackMcpV11Sender(server: McpV11StatelessServer): McpV11Transport {
  return {
    async request(request, headers = {}) {
      return server.dispatch(request, headers);
    },
  };
}

/** Client-side view of a discovered server. */
export interface McpV11ServerInfo {
  discover: McpV11DiscoverResult;
  routingKey?: string;
}

/**
 * Stateless v11 client: discover-first, `_meta` on every
 * request, routing headers on every request, cacheable lists.
 * The client never sends `initialize` and never stores a
 * session id — there is nothing to store.
 */
export class McpV11StatelessClient {
  private idCounter = 1;
  private discovered: McpV11DiscoverResult | null = null;
  readonly listCache = new McpV11ListCache();
  /** Routing headers the last request carried (for tests / audit). */
  lastRoutingHeaders: McpV11RoutingHeaders | null = null;

  constructor(
    private readonly transport: McpV11Transport,
    private readonly opts: {
      clientInfo?: { name: string; version: string };
      capabilities?: Partial<McpV11Capabilities>;
      targetServer?: string;
    } = {},
  ) {}

  private nextId(): number {
    return this.idCounter++;
  }

  private async send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const meta = buildMcpV11RequestMeta(this.opts.capabilities ?? {}, {
      clientInfo: this.opts.clientInfo,
      routingKey: this.discovered?.routing[this.discovered.serverInfo.name],
    });
    const headers = buildMcpV11RoutingHeaders({ targetServer: this.opts.targetServer });
    this.lastRoutingHeaders = headers;
    const response = await this.transport.request(
      { jsonrpc: '2.0', method, params: { ...params, _meta: meta }, id: this.nextId() },
      mcpV11RoutingHeadersToWire(headers),
    );
    if (response.error) {
      throw new McpV11StatelessError(
        (response.error.data as Record<string, unknown> | undefined)?.code as string ?? 'rpc-error',
        response.error.code,
        response.error.message,
      );
    }
    return (response.result ?? {}) as Record<string, unknown>;
  }

  /** Discover the server. Must be called before any other method. */
  async discover(): Promise<McpV11DiscoverResult> {
    const response = await this.transport.request({
      jsonrpc: '2.0',
      method: MCP_V11_DISCOVER_METHOD,
      params: {},
      id: this.nextId(),
    });
    if (response.error) {
      throw new McpV11StatelessError('discover-failed', response.error.code, response.error.message);
    }
    const result = response.result as unknown as McpV11DiscoverResult;
    const problems = validateMcpV11DiscoverResult(result);
    if (problems.length > 0) {
      throw new McpV11StatelessError('invalid-discover', -32602, 'Invalid discover result: ' + problems.join(' '));
    }
    this.discovered = result;
    return result;
  }

  private ensureDiscovered(): void {
    if (!this.discovered) throw new McpV11StatelessError('not-discovered', -32000, 'Call discover() before any other method.');
  }

  /** List tools, using the cache when the server says nothing changed. */
  async listTools(): Promise<McpV11ListResult> {
    this.ensureDiscovered();
    const cached = this.listCache.get('tools');
    const params: Record<string, unknown> = {};
    if (cached.hit && !cached.stale && cached.listHash) params.knownListHash = cached.listHash;
    const result = (await this.send('tools/list', params)) as unknown as McpV11ListResult;
    if (!result.notModified) this.listCache.put('tools', result);
    else if (cached.entries) return { notModified: false, entries: cached.entries, listHash: result.listHash, listVersion: result.listVersion };
    return result;
  }

  /** List resources, using the cache when the server says nothing changed. */
  async listResources(): Promise<McpV11ListResult> {
    this.ensureDiscovered();
    const cached = this.listCache.get('resources');
    const params: Record<string, unknown> = {};
    if (cached.hit && !cached.stale && cached.listHash) params.knownListHash = cached.listHash;
    const result = (await this.send('resources/list', params)) as unknown as McpV11ListResult;
    if (!result.notModified) this.listCache.put('resources', result);
    else if (cached.entries) return { notModified: false, entries: cached.entries, listHash: result.listHash, listVersion: result.listVersion };
    return result;
  }

  /** Call one tool. Returns the raw result object (may be `input_required`). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.ensureDiscovered();
    return this.send('tools/call', { name, arguments: args });
  }

  /** The discover document, or null before discover(). */
  get server(): McpV11DiscoverResult | null {
    return this.discovered;
  }

  /** Extensions the discovered server offers. */
  get extensions(): string[] {
    return this.discovered?.extensions ?? [];
  }

  /** True when the discovered server offers the named extension. */
  hasExtension(extension: string): boolean {
    return this.extensions.includes(extension);
  }
}

/** Convenience: does this discover result offer the Tasks extension? */
export function mcpV11OffersTasks(discover: McpV11DiscoverResult): boolean {
  return discover.extensions.includes(MCP_V11_TASKS_EXTENSION);
}

/** Convenience: does this discover result offer the UI (Apps) extension? */
export function mcpV11OffersApps(discover: McpV11DiscoverResult): boolean {
  return discover.extensions.includes(MCP_V11_UI_EXTENSION);
}
