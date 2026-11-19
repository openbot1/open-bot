/**
 * Protocols v8 — MCP stateless core with server/discover (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1): MCP spec 2026-07-28
 * makes HTTP stateless — no handshake, no session id — and
 * adds `server/discover` so a client asks for capabilities
 * BEFORE calling anything. Every request is self-describing:
 * it carries its protocol version AND its capabilities
 * (including the extensions it wants) in `_meta`.
 *
 * This module is the v8 continuation of `protocolsV7/
 * mcpStatelessV7.ts` — same shape, extended:
 *
 *   - `server/discover` answers with the protocol version,
 *     the capability advertisement, the extension registry
 *     (with per-extension status) and the deprecation table,
 *     so a client never has to guess what the server speaks.
 *   - `_meta.capabilities` on a request carries the client's
 *     capabilities; `_meta.extensions` lists the extensions
 *     the client wants. The server answers each request with
 *     the negotiated extension set for THAT request only —
 *     extensions are negotiated per request, never stored,
 *     because the transport holds no sessions.
 *   - Session-only methods (`initialize`,
 *     `notifications/initialized`) are still REFUSED here.
 *     The old stateful handshake lives ONLY in
 *     `McpV8LegacySessionAdapter` (same file, separate class,
 *     clearly marked legacy): it keeps a session map, answers
 *     `initialize`, and delegates every stateless method to a
 *     `McpV8StatelessServer`. New code must use the stateless
 *     server; the adapter exists so old peers keep working
 *     until the 2027-07-28 removal floor, with a deprecation
 *     warning on every session it opens.
 *   - `McpV8StatelessClient` speaks the same shape over a
 *     transport interface (loopback in-process, or HTTP fetch
 *     via a host-supplied sender) and always calls
 *     `discover()` first.
 *
 * No code, text or asset from any other repo is copied here.
 * No network is opened by this module: the HTTP sender is
 * host-supplied (fetch in `a2aClientV7.ts` style, or loopback).
 */

import { randomUUID } from 'node:crypto';
import {
  MCP_V8_CURRENT_VERSION,
  MCP_V8_DEPRECATIONS,
  MCP_V8_EXTENSIONS,
  MCP_V8_SESSION_ONLY_METHODS,
  MCP_V8_STATELESS_METHODS,
  defaultMcpV8ExtensionOffer,
  defaultProtocolV8Capabilities,
  negotiateMcpV8Extensions,
  negotiateProtocolV8Capabilities,
  protocolV8MatrixSummary,
  type McpV8ExtensionId,
  type McpV8ExtensionNegotiation,
  type McpV8StatelessMethod,
  type ProtocolV8CapabilityAdvertisement,
} from './versionsV8';

/** Error raised by the v8 MCP stateless layer. */
export class McpV8StatelessError extends Error {
  readonly code: string;
  /** JSON-RPC error code. */
  readonly rpcCode: number;
  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = 'McpV8StatelessError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** Capabilities a client advertises inside `_meta.capabilities`. */
export interface McpV8MetaCapabilities {
  /** Extensions the client wants (negotiated per request, default off). */
  extensions?: string[];
  /** Whether the client speaks stateless HTTP. */
  statelessHttp?: boolean;
  /** Whether the client can render MCP Apps UI. */
  mcpApps?: boolean;
  /** Whether the client can poll Tasks. */
  mcpTasks?: boolean;
  /** Elicitation modes the client supports. */
  elicitationModes?: string[];
}

/** Self-description carried on EVERY stateless request. */
export interface McpV8RequestMeta {
  /** MCP protocol version (must be the current 2026-07-28, or a legacy version the server still speaks). */
  protocolVersion: string;
  /** Client name (for logs, never credentials). */
  clientName?: string;
  /** Client version. */
  clientVersion?: string;
  /** Tenant the request acts for. */
  tenant?: string;
  /** Caller-supplied request id (for tracing; the server echoes it). */
  requestId?: string;
  /** Client capabilities (extensions wanted, UI/task support). */
  capabilities?: McpV8MetaCapabilities;
  /** Extensions requested (shorthand; merged with capabilities.extensions). */
  extensions?: string[];
}

/** JSON-RPC 2.0 request on the stateless transport. */
export interface McpV8JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown> & { _meta?: McpV8RequestMeta };
}

/** JSON-RPC 2.0 response. */
export type McpV8JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string; data?: unknown } };

/** JSON Schema fragment for a tool's input (subset, JSON-able). */
export interface McpV8InputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * UI declaration a tool may carry in `_meta.ui` (MCP Apps
 * extension): the resource URI of the HTML to render.
 * The host validates it (see `mcpAppsV8.ts`); the server only
 * records and advertises it.
 */
export interface McpV8ToolUiDeclaration {
  /** Resource URI of the UI, e.g. `ui://my-tool/main`. */
  resourceUri: string;
  /** Preferred width/height hints for the host (optional). */
  preferredWidth?: number;
  preferredHeight?: number;
}

/** A tool registered on the stateless server. */
export interface McpV8ToolDefinition {
  name: string;
  description: string;
  inputSchema: McpV8InputSchema;
  /** Free-form annotations (read-only hint, idempotency, …). */
  annotations?: Record<string, unknown>;
  /** MCP Apps UI declaration (only honoured when the ui extension is negotiated). */
  ui?: McpV8ToolUiDeclaration;
}

/** A resource registered on the stateless server. */
export interface McpV8ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt registered on the stateless server. */
export interface McpV8PromptDefinition {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** Result of a tool call. */
export interface McpV8ToolResult {
  /** Text / data content blocks. */
  content: { type: 'text' | 'resource'; text?: string; uri?: string; mimeType?: string }[];
  /** True when the tool itself reported an error (not a transport error). */
  isError: boolean;
  /** Structured result (when the tool returns one). */
  structuredContent?: Record<string, unknown>;
  /**
   * Task handle (Tasks extension): present when the call is
   * long-running and the server returned a handle instead of
   * a final result. The caller polls `tasks/get`.
   */
  task?: { taskId: string; status: string };
}

/** Fresh per-request context (built from the request, never stored). */
export interface McpV8RequestContext {
  meta: McpV8RequestMeta;
  tenant: string;
  /** Request id (echoed back for tracing). */
  requestId: string;
  /** Authenticated identity (when the host verified a token). */
  identity?: string;
  /** Arrival time (ms since epoch). */
  receivedAtMs: number;
  /** Extensions negotiated for THIS request only (never stored). */
  extensions: McpV8ExtensionNegotiation;
  /** Capability intersection for THIS request only. */
  capabilities: ProtocolV8CapabilityAdvertisement;
}

/** A tool handler: pure function of (args, fresh context). */
export type McpV8ToolHandler = (
  args: Record<string, unknown>,
  ctx: McpV8RequestContext,
) => Promise<McpV8ToolResult> | McpV8ToolResult;

/** A resource reader: pure function of (uri, fresh context). */
export type McpV8ResourceReader = (
  uri: string,
  ctx: McpV8RequestContext,
) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> | { contents: { uri: string; mimeType: string; text: string }[] };

/** A prompt renderer: pure function of (args, fresh context). */
export type McpV8PromptRenderer = (
  args: Record<string, unknown>,
  ctx: McpV8RequestContext,
) => Promise<{ messages: { role: string; content: { type: string; text: string } }[] }> | { messages: { role: string; content: { type: string; text: string } }[] };

/** Server options. */
export interface McpV8StatelessServerOptions {
  /** Protocol versions the server accepts (default: current only). */
  acceptedVersions?: readonly string[];
  /** Per-tenant bearer tokens (empty = no auth). */
  tenantTokens?: Record<string, string>;
  /** Max tool-call arguments size in bytes (default 1MB). */
  maxArgsBytes?: number;
  /** Default tenant (default `default`). */
  defaultTenant?: string;
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Server info advertised by server/discover. */
  serverInfo?: { name: string; version: string };
  /** Extensions the server offers (default: all implemented). */
  extensionOffer?: readonly McpV8ExtensionId[];
}

/** The server/discover document. */
export interface McpV8DiscoverDocument {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: ProtocolV8CapabilityAdvertisement;
  /** Extensions the server implements (with status), before negotiation. */
  extensions: { id: string; alias: string; status: string; implemented: boolean }[];
  /** Extensions negotiated for the discovering request. */
  negotiatedExtensions: McpV8ExtensionId[];
  /** Deprecated features (so the client knows what not to adopt). */
  deprecations: { feature: string; earliestRemoval: string; replacement: string }[];
  /** Preferred transport first. */
  transports: readonly string[];
  /** One-line matrix summary. */
  matrix: string;
}

const MCP_RPC_INVALID_REQUEST = -32600;
const MCP_RPC_METHOD_NOT_FOUND = -32601;
const MCP_RPC_INVALID_PARAMS = -32602;
const MCP_RPC_INTERNAL_ERROR = -32603;
const MCP_RPC_UNAUTHORIZED = -32001;
const MCP_RPC_NOT_FOUND = -32002;
const MCP_RPC_NOT_SELF_DESCRIBING = -32005;
const MCP_RPC_SESSION_REQUIRED = -32006;
const MCP_RPC_EXTENSION_NOT_NEGOTIATED = -32007;

/** JSON-RPC error codes used by the v8 stateless transport. */
export const MCP_V8_STATELESS_ERROR_CODES = {
  invalidRequest: MCP_RPC_INVALID_REQUEST,
  methodNotFound: MCP_RPC_METHOD_NOT_FOUND,
  invalidParams: MCP_RPC_INVALID_PARAMS,
  internalError: MCP_RPC_INTERNAL_ERROR,
  unauthorized: MCP_RPC_UNAUTHORIZED,
  notFound: MCP_RPC_NOT_FOUND,
  notSelfDescribing: MCP_RPC_NOT_SELF_DESCRIBING,
  sessionRequired: MCP_RPC_SESSION_REQUIRED,
  extensionNotNegotiated: MCP_RPC_EXTENSION_NOT_NEGOTIATED,
} as const;

/**
 * Validate the self-description of a request. Returns the
 * normalised meta, or throws McpV8StatelessError (encoded as a
 * JSON-RPC error by `handle()`).
 */
export function requireMcpV8SelfDescribing(
  request: McpV8JsonRpcRequest,
  acceptedVersions: readonly string[],
): McpV8RequestMeta {
  const meta = request.params?._meta as McpV8RequestMeta | undefined;
  if (!meta || typeof meta !== 'object') {
    throw new McpV8StatelessError(
      'not-self-describing',
      MCP_RPC_NOT_SELF_DESCRIBING,
      'Stateless request must carry _meta (protocolVersion, …): no handshake, no session id — every request describes itself.',
    );
  }
  if (typeof meta.protocolVersion !== 'string' || meta.protocolVersion.length === 0) {
    throw new McpV8StatelessError(
      'not-self-describing',
      MCP_RPC_NOT_SELF_DESCRIBING,
      'Stateless request _meta.protocolVersion is required.',
    );
  }
  if (!acceptedVersions.includes(meta.protocolVersion)) {
    throw new McpV8StatelessError(
      'unsupported-version',
      MCP_RPC_INVALID_PARAMS,
      `Unsupported MCP protocol version "${meta.protocolVersion}" (accepted: ${acceptedVersions.join(', ')}).`,
    );
  }
  return meta;
}

/**
 * Collect the extensions a request asks for: `_meta.extensions`
 * plus `_meta.capabilities.extensions`, de-duplicated, in
 * request order.
 */
export function mcpV8RequestedExtensions(meta: McpV8RequestMeta): string[] {
  const out: string[] = [];
  const add = (list: readonly string[] | undefined): void => {
    for (const id of list ?? []) {
      if (typeof id === 'string' && id.length > 0 && !out.includes(id)) out.push(id);
    }
  };
  add(meta.extensions);
  add(meta.capabilities?.extensions);
  return out;
}

/** Build a self-describing request (client-side helper). */
export function buildMcpV8Request(
  method: string,
  params: Record<string, unknown> | undefined,
  meta: McpV8RequestMeta,
  id?: string | number,
): McpV8JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: id ?? `mcp-v8-${randomUUID()}`,
    method,
    params: { ...(params ?? {}), _meta: { ...meta } },
  };
}

/** Build the server/discover document for one request's negotiation. */
export function buildMcpV8DiscoverDocument(
  serverInfo: { name: string; version: string },
  negotiated: McpV8ExtensionNegotiation,
  capabilities: ProtocolV8CapabilityAdvertisement,
): McpV8DiscoverDocument {
  return {
    protocolVersion: MCP_V8_CURRENT_VERSION,
    serverInfo: { ...serverInfo },
    capabilities: { ...capabilities, elicitationModes: [...capabilities.elicitationModes] },
    extensions: MCP_V8_EXTENSIONS.map((e) => ({
      id: e.id,
      alias: e.alias,
      status: e.status,
      implemented: e.implemented,
    })),
    negotiatedExtensions: [...negotiated.active],
    deprecations: MCP_V8_DEPRECATIONS.map((d) => ({
      feature: d.feature,
      earliestRemoval: d.earliestRemoval,
      replacement: d.replacement,
    })),
    transports: ['streamable-http', 'stdio', 'http-sse'],
    matrix: protocolV8MatrixSummary(),
  };
}

/**
 * MCP stateless server (v8): tools / resources / prompts
 * registered once; every request handled from its own `_meta`
 * with a fresh context and a per-request extension
 * negotiation. No session map, no handshake state —
 * `sessionCount()` is always 0.
 */
export class McpV8StatelessServer {
  private tools = new Map<string, { definition: McpV8ToolDefinition; handler: McpV8ToolHandler }>();
  private resources = new Map<string, { definition: McpV8ResourceDefinition; reader: McpV8ResourceReader }>();
  private prompts = new Map<string, { definition: McpV8PromptDefinition; renderer: McpV8PromptRenderer }>();
  private acceptedVersions: readonly string[];
  private tenantTokens: Map<string, string>;
  private maxArgsBytes: number;
  private defaultTenant: string;
  private nowMs: () => number;
  private serverInfo: { name: string; version: string };
  private extensionOffer: readonly McpV8ExtensionId[];
  private handledRequests = 0;
  private discoverCalls = 0;

  constructor(options: McpV8StatelessServerOptions = {}) {
    this.acceptedVersions = options.acceptedVersions ?? [MCP_V8_CURRENT_VERSION];
    this.tenantTokens = new Map(Object.entries(options.tenantTokens ?? {}));
    this.maxArgsBytes = options.maxArgsBytes ?? 1024 * 1024;
    this.defaultTenant = options.defaultTenant ?? 'default';
    this.nowMs = options.nowMs ?? Date.now;
    this.serverInfo = options.serverInfo ?? { name: 'open-bot', version: '1.39' };
    this.extensionOffer = options.extensionOffer ?? defaultMcpV8ExtensionOffer();
  }

  /** Number of sessions held: always 0 (stateless by construction). */
  sessionCount(): number {
    return 0;
  }

  /** Total requests handled (a counter, not per-client state). */
  handledCount(): number {
    return this.handledRequests;
  }

  /** How many server/discover calls were answered. */
  discoverCount(): number {
    return this.discoverCalls;
  }

  /** Server info advertised by server/discover. */
  info(): { name: string; version: string } {
    return { ...this.serverInfo };
  }

  /** Register a tool (re-registering the same name replaces it). */
  registerTool(definition: McpV8ToolDefinition, handler: McpV8ToolHandler): void {
    if (!definition.name || typeof definition.name !== 'string') {
      throw new McpV8StatelessError('invalid-tool', MCP_RPC_INVALID_PARAMS, 'Tool needs a non-empty name.');
    }
    if (definition.ui !== undefined) {
      if (typeof definition.ui.resourceUri !== 'string' || !definition.ui.resourceUri.startsWith('ui://')) {
        throw new McpV8StatelessError(
          'invalid-tool-ui',
          MCP_RPC_INVALID_PARAMS,
          `Tool "${definition.name}" declares UI with resourceUri "${definition.ui.resourceUri}": MCP Apps UI must point at a ui:// resource.`,
        );
      }
    }
    this.tools.set(definition.name, { definition: { ...definition }, handler });
  }

  /** Register a resource reader. */
  registerResource(definition: McpV8ResourceDefinition, reader: McpV8ResourceReader): void {
    if (!definition.uri || typeof definition.uri !== 'string') {
      throw new McpV8StatelessError('invalid-resource', MCP_RPC_INVALID_PARAMS, 'Resource needs a non-empty uri.');
    }
    this.resources.set(definition.uri, { definition: { ...definition }, reader });
  }

  /** Register a prompt renderer. */
  registerPrompt(definition: McpV8PromptDefinition, renderer: McpV8PromptRenderer): void {
    if (!definition.name || typeof definition.name !== 'string') {
      throw new McpV8StatelessError('invalid-prompt', MCP_RPC_INVALID_PARAMS, 'Prompt needs a non-empty name.');
    }
    this.prompts.set(definition.name, { definition: { ...definition }, renderer });
  }

  /** Unregister a tool (false when missing). */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Tool names (sorted, for discovery). */
  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Resource URIs (sorted). */
  resourceUris(): string[] {
    return [...this.resources.keys()].sort();
  }

  /** Prompt names (sorted). */
  promptNames(): string[] {
    return [...this.prompts.keys()].sort();
  }

  /** Tools that declare MCP Apps UI (only meaningful when the ui extension is negotiated). */
  uiToolNames(): string[] {
    return [...this.tools.values()]
      .filter((t) => t.definition.ui !== undefined)
      .map((t) => t.definition.name)
      .sort();
  }

  /**
   * Handle one stateless request. `authorization` is the raw
   * Authorization header value (when the host passes one).
   * Never throws for a bad request — errors are encoded.
   */
  async handle(
    request: unknown,
    authorization?: string,
  ): Promise<McpV8JsonRpcResponse> {
    const req = request as Partial<McpV8JsonRpcRequest> | null;
    const id = (req && typeof req === 'object' && 'id' in req
      ? (req.id as string | number)
      : `mcp-v8-${randomUUID()}`);
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0'
      || typeof req.method !== 'string' || req.method.length === 0) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: MCP_RPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object with a method.' },
      };
    }
    if ((MCP_V8_SESSION_ONLY_METHODS as readonly string[]).includes(req.method)) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_RPC_SESSION_REQUIRED,
          message: `Method "${req.method}" needs a session (stateful handshake) and is refused on the stateless transport (spec 2026-07-28). Use the legacy session adapter for old peers, or send self-describing requests.`,
        },
      };
    }
    try {
      const meta = requireMcpV8SelfDescribing(req as McpV8JsonRpcRequest, this.acceptedVersions);
      const tenant = typeof meta.tenant === 'string' && meta.tenant.length > 0 ? meta.tenant : this.defaultTenant;
      this.checkAuth(tenant, authorization);
      const requested = mcpV8RequestedExtensions(meta);
      const extensions = negotiateMcpV8Extensions(this.extensionOffer, requested);
      const capabilities = negotiateProtocolV8Capabilities({
        ...defaultProtocolV8Capabilities(),
        mcpStatelessHttp: meta.capabilities?.statelessHttp !== false,
      });
      const ctx: McpV8RequestContext = {
        meta,
        tenant,
        requestId: meta.requestId ?? String(id),
        identity: this.identityOf(tenant, authorization),
        receivedAtMs: this.nowMs(),
        extensions,
        capabilities,
      };
      const result = await this.dispatch(req.method, (req.params ?? {}) as Record<string, unknown>, ctx);
      this.handledRequests += 1;
      if (req.method === 'server/discover') this.discoverCalls += 1;
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof McpV8StatelessError) {
        return { jsonrpc: '2.0', id, error: { code: err.rpcCode, message: err.message, data: { code: err.code } } };
      }
      return { jsonrpc: '2.0', id, error: { code: MCP_RPC_INTERNAL_ERROR, message: 'Internal server error.' } };
    }
  }

  /** Handle a batch (each request answered independently). */
  async handleBatch(
    requests: unknown[],
    authorization?: string,
  ): Promise<McpV8JsonRpcResponse[]> {
    const out: McpV8JsonRpcResponse[] = [];
    for (const req of requests) out.push(await this.handle(req, authorization));
    return out;
  }

  private checkAuth(tenant: string, authorization: string | undefined): void {
    const expected = this.tenantTokens.get(tenant);
    if (expected === undefined) return;
    if (typeof authorization !== 'string') {
      throw new McpV8StatelessError('unauthorized', MCP_RPC_UNAUTHORIZED, `Tenant "${tenant}" needs an Authorization header.`);
    }
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
    if (token.length === 0 || token !== expected) {
      throw new McpV8StatelessError('unauthorized', MCP_RPC_UNAUTHORIZED, `Bad token for tenant "${tenant}".`);
    }
  }

  private identityOf(tenant: string, authorization: string | undefined): string | undefined {
    if (this.tenantTokens.has(tenant) && authorization) return `tenant:${tenant}`;
    return undefined;
  }

  private checkArgsSize(params: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf-8');
    if (bytes > this.maxArgsBytes) {
      throw new McpV8StatelessError(
        'args-too-large',
        MCP_RPC_INVALID_PARAMS,
        `Tool arguments are ${bytes} bytes (max ${this.maxArgsBytes}).`,
      );
    }
  }

  private requireParam(params: Record<string, unknown>, name: string): unknown {
    const value = params[name];
    if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
      throw new McpV8StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, `Param "${name}" is required.`);
    }
    return value;
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    ctx: McpV8RequestContext,
  ): Promise<unknown> {
    switch (method as McpV8StatelessMethod) {
      case 'server/discover':
        return buildMcpV8DiscoverDocument(this.serverInfo, ctx.extensions, ctx.capabilities);
      case 'ping':
        return {
          ok: true,
          protocolVersion: ctx.meta.protocolVersion,
          tenant: ctx.tenant,
          requestId: ctx.requestId,
          extensions: ctx.extensions.active,
        };
      case 'tools/list': {
        const tools = [...this.tools.values()].map((t) => t.definition);
        // Without the ui extension negotiated, UI declarations are
        // hidden: a client that cannot render must not see them.
        if (!ctx.extensions.appsActive) {
          return { tools: tools.map((t) => ({ ...t, ui: undefined })) };
        }
        return { tools };
      }
      case 'tools/call': {
        this.checkArgsSize(params);
        const name = this.requireParam(params, 'name') as string;
        const entry = this.tools.get(name);
        if (!entry) {
          throw new McpV8StatelessError('tool-not-found', MCP_RPC_NOT_FOUND, `Tool "${name}" is not registered.`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new McpV8StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, 'Param "arguments" must be an object.');
        }
        this.validateToolArgs(entry.definition, args);
        return entry.handler(args, ctx);
      }
      case 'resources/list':
        return { resources: [...this.resources.values()].map((r) => r.definition) };
      case 'resources/read': {
        const uri = this.requireParam(params, 'uri') as string;
        const entry = this.resources.get(uri);
        if (!entry) {
          throw new McpV8StatelessError('resource-not-found', MCP_RPC_NOT_FOUND, `Resource "${uri}" is not registered.`);
        }
        return entry.reader(uri, ctx);
      }
      case 'prompts/list':
        return { prompts: [...this.prompts.values()].map((p) => p.definition) };
      case 'prompts/get': {
        const name = this.requireParam(params, 'name') as string;
        const entry = this.prompts.get(name);
        if (!entry) {
          throw new McpV8StatelessError('prompt-not-found', MCP_RPC_NOT_FOUND, `Prompt "${name}" is not registered.`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new McpV8StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, 'Param "arguments" must be an object.');
        }
        return entry.renderer(args, ctx);
      }
      default:
        throw new McpV8StatelessError(
          'method-not-found',
          MCP_RPC_METHOD_NOT_FOUND,
          `Method "${method}" is not part of the MCP stateless surface (known: ${MCP_V8_STATELESS_METHODS.join(', ')}).`,
        );
    }
  }

  /** Validate tool arguments against the tool's required fields. */
  private validateToolArgs(definition: McpV8ToolDefinition, args: Record<string, unknown>): void {
    const required = definition.inputSchema.required ?? [];
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        throw new McpV8StatelessError(
          'invalid-params',
          MCP_RPC_INVALID_PARAMS,
          `Tool "${definition.name}" needs argument "${field}".`,
        );
      }
    }
  }
}

/**
 * LEGACY — the old stateful handshake, kept apart from the
 * stateless path on purpose. `McpV8LegacySessionAdapter`
 * answers `initialize` / `notifications/initialized`, keeps a
 * session map (one entry per client), and delegates every
 * stateless method to a `McpV8StatelessServer`. Every session
 * it opens is stamped with a deprecation warning (Sampling /
 * Roots / Logging / initialize leave after 2027-07-28).
 * New code must use `McpV8StatelessServer` directly; this
 * adapter exists only so old peers keep working until the
 * removal floor.
 */
export interface McpV8LegacySession {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  requests: number;
  /** Deprecation warning attached to the session at creation. */
  deprecationWarning: string;
}

export interface McpV8LegacySessionAdapterOptions {
  /** Clock override (ms since epoch). */
  nowMs?: () => number;
  /** Max live sessions (default 64; oldest evicted first). */
  maxSessions?: number;
}

export const MCP_V8_LEGACY_SESSION_WARNING =
  'Stateful MCP session (initialize handshake) is deprecated: it leaves after 2027-07-28. Migrate to stateless requests (protocol version + capabilities in _meta, server/discover first).';

export class McpV8LegacySessionAdapter {
  private server: McpV8StatelessServer;
  private sessions = new Map<string, McpV8LegacySession>();
  private nowMs: () => number;
  private maxSessions: number;
  private refusedStateless = 0;

  constructor(server: McpV8StatelessServer, options: McpV8LegacySessionAdapterOptions = {}) {
    this.server = server;
    this.nowMs = options.nowMs ?? Date.now;
    this.maxSessions = options.maxSessions ?? 64;
  }

  /** Number of live legacy sessions (the stateless server itself still holds 0). */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** The wrapped stateless server (still holds zero sessions). */
  statelessServer(): McpV8StatelessServer {
    return this.server;
  }

  /** List live session ids (sorted). */
  sessionIds(): string[] {
    return [...this.sessions.keys()].sort();
  }

  /** Get one session (undefined when missing/expired). */
  getSession(sessionId: string): McpV8LegacySession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Close one session (false when missing). */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Close all legacy sessions. */
  closeAllSessions(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  /**
   * Handle one legacy request. `initialize` opens a session;
   * `notifications/initialized` marks it initialised; any
   * stateless method is delegated to the wrapped server with a
   * synthetic self-describing `_meta` (the session's version).
   * Returns a JSON-RPC response; never throws for a bad request.
   */
  async handleLegacy(
    request: unknown,
    authorization?: string,
  ): Promise<McpV8JsonRpcResponse> {
    const req = request as Partial<McpV8JsonRpcRequest> | null;
    const id = (req && typeof req === 'object' && 'id' in req
      ? (req.id as string | number)
      : `mcp-v8-legacy-${randomUUID()}`);
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0'
      || typeof req.method !== 'string' || req.method.length === 0) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: MCP_RPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object with a method.' },
      };
    }
    if (req.method === 'initialize') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const protocolVersion = typeof params['protocolVersion'] === 'string' && params['protocolVersion'].length > 0
        ? (params['protocolVersion'] as string)
        : MCP_V8_CURRENT_VERSION;
      const clientInfo = (params['clientInfo'] ?? {}) as Record<string, unknown>;
      const sessionId = `mcp-v8-legacy-${randomUUID()}`;
      const now = this.nowMs();
      const session: McpV8LegacySession = {
        sessionId,
        clientName: typeof clientInfo['name'] === 'string' ? (clientInfo['name'] as string) : undefined,
        clientVersion: typeof clientInfo['version'] === 'string' ? (clientInfo['version'] as string) : undefined,
        protocolVersion,
        createdAtMs: now,
        lastSeenAtMs: now,
        requests: 0,
        deprecationWarning: MCP_V8_LEGACY_SESSION_WARNING,
      };
      this.sessions.set(sessionId, session);
      while (this.sessions.size > this.maxSessions) {
        const oldest = [...this.sessions.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
        if (!oldest) break;
        this.sessions.delete(oldest.sessionId);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          serverInfo: this.server.info(),
          capabilities: defaultProtocolV8Capabilities(),
          sessionId,
          deprecated: true,
          warning: MCP_V8_LEGACY_SESSION_WARNING,
        },
      };
    }
    if (req.method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id, result: { ok: true, deprecated: true, warning: MCP_V8_LEGACY_SESSION_WARNING } };
    }
    if ((MCP_V8_STATELESS_METHODS as readonly string[]).includes(req.method)) {
      const sessionId = sessionIdFrom(paramsOf(req));
      const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
      if (session === undefined) {
        this.refusedStateless += 1;
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: MCP_RPC_SESSION_REQUIRED,
            message: 'Legacy session call needs a known session id in params._sessionId (open one with initialize first).',
            data: { code: 'session-required' },
          },
        };
      }
      session.lastSeenAtMs = this.nowMs();
      session.requests += 1;
      const meta: McpV8RequestMeta = {
        protocolVersion: session.protocolVersion,
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        requestId: String(id),
      };
      const forwarded: McpV8JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method: req.method,
        params: { ...((req.params ?? {}) as Record<string, unknown>), _meta: meta },
      };
      return this.server.handle(forwarded, authorization);
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: MCP_RPC_METHOD_NOT_FOUND, message: `Method "${req.method}" is not part of the legacy MCP surface.` },
    };
  }

  /** How many stateless-via-legacy calls were refused for a missing session. */
  refusedCount(): number {
    return this.refusedStateless;
  }
}

function paramsOf(req: Partial<McpV8JsonRpcRequest>): Record<string, unknown> {
  return (req.params ?? {}) as Record<string, unknown>;
}

function sessionIdFrom(params: Record<string, unknown>): string | undefined {
  const raw = params['_sessionId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** A sender the stateless client posts requests through (host-supplied). */
export type McpV8StatelessSender = (
  request: McpV8JsonRpcRequest,
  authorization?: string,
) => Promise<McpV8JsonRpcResponse>;

/** Transport alias (same shape as the sender): what the host binds for discover. */
export type McpV8StatelessTransport = McpV8StatelessSender;

/** Client options. */
export interface McpV8StatelessClientOptions {
  /** Protocol version stamped on every request (default: current). */
  protocolVersion?: string;
  /** Client name stamped on every request. */
  clientName?: string;
  /** Client version stamped on every request. */
  clientVersion?: string;
  /** Tenant stamped on every request (default `default`). */
  tenant?: string;
  /** Bearer token sent with every request (undefined = no auth). */
  bearerToken?: string;
  /** Extensions the client wants (default: all implemented). */
  extensions?: readonly string[];
  /** Whether the client can render MCP Apps UI. */
  mcpApps?: boolean;
  /** Whether the client can poll Tasks. */
  mcpTasks?: boolean;
}

/**
 * MCP stateless client (v8): builds a fresh self-describing
 * request for every call (no handshake, no stored session),
 * stamps capabilities + extensions in `_meta`, and posts it
 * through the host-supplied sender. Call `discover()` first:
 * it asks the server what it speaks before any tool call.
 */
export class McpV8StatelessClient {
  private sender: McpV8StatelessSender;
  private options: McpV8StatelessClientOptions;
  private requestSeq = 0;
  private lastDiscover: McpV8DiscoverDocument | undefined;

  constructor(sender: McpV8StatelessSender, options: McpV8StatelessClientOptions = {}) {
    this.sender = sender;
    this.options = { ...options };
  }

  /** Build the `_meta` stamped on every request. */
  meta(): McpV8RequestMeta {
    return {
      protocolVersion: this.options.protocolVersion ?? MCP_V8_CURRENT_VERSION,
      clientName: this.options.clientName ?? 'open-bot',
      clientVersion: this.options.clientVersion ?? '1.39',
      tenant: this.options.tenant ?? 'default',
      requestId: `req-${++this.requestSeq}-${randomUUID()}`,
      capabilities: {
        extensions: [...(this.options.extensions ?? defaultMcpV8ExtensionOffer())],
        statelessHttp: true,
        mcpApps: this.options.mcpApps ?? false,
        mcpTasks: this.options.mcpTasks ?? false,
        elicitationModes: ['form', 'url'],
      },
      extensions: [...(this.options.extensions ?? defaultMcpV8ExtensionOffer())],
    };
  }

  /** Last server/discover document (undefined before discover()). */
  discovered(): McpV8DiscoverDocument | undefined {
    return this.lastDiscover;
  }

  /** Ask the server what it speaks (capabilities + extensions + deprecations). */
  async discover(): Promise<McpV8DiscoverDocument> {
    const doc = await this.call<McpV8DiscoverDocument>('server/discover', {});
    this.lastDiscover = doc;
    return doc;
  }

  /** Ping the server (also proves the request is self-describing). */
  async ping(): Promise<{ ok: boolean; protocolVersion: string; tenant: string; requestId: string; extensions: string[] }> {
    return this.call('ping', {});
  }

  /** List the server's tools (UI declarations only when the ui extension is negotiated). */
  async listTools(): Promise<{ tools: McpV8ToolDefinition[] }> {
    return this.call('tools/list', {});
  }

  /** Call a tool (arguments are validated server-side too). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpV8ToolResult> {
    return this.call('tools/call', { name, arguments: args });
  }

  /** List the server's resources. */
  async listResources(): Promise<{ resources: McpV8ResourceDefinition[] }> {
    return this.call('resources/list', {});
  }

  /** Read a resource. */
  async readResource(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
    return this.call('resources/read', { uri });
  }

  /** List the server's prompts. */
  async listPrompts(): Promise<{ prompts: McpV8PromptDefinition[] }> {
    return this.call('prompts/list', {});
  }

  /** Render a prompt. */
  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ messages: { role: string; content: { type: string; text: string } }[] }> {
    return this.call('prompts/get', { name, arguments: args });
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const request = buildMcpV8Request(method, params, this.meta());
    const authorization = this.options.bearerToken ? `Bearer ${this.options.bearerToken}` : undefined;
    const response = await this.sender(request, authorization);
    if ('error' in response) {
      throw new McpV8StatelessError(
        'rpc-error',
        response.error.code,
        `Call ${method} failed: ${response.error.message}`,
      );
    }
    return response.result as T;
  }
}

/** Create a loopback sender over a server (tests + local hosts). */
export function createLoopbackMcpV8Sender(server: McpV8StatelessServer): McpV8StatelessSender {
  return (request, authorization) => server.handle(request, authorization);
}

/**
 * Prove a server is stateless: two identical requests must give
 * identical results, and the server must hold zero sessions.
 * Returns the check result (never throws).
 */
export async function checkMcpV8Stateless(
  server: McpV8StatelessServer,
  request: McpV8JsonRpcRequest,
  authorization?: string,
): Promise<{ stateless: boolean; sessions: number; identical: boolean; reason: string }> {
  if (server.sessionCount() !== 0) {
    return { stateless: false, sessions: server.sessionCount(), identical: false, reason: 'Server holds sessions.' };
  }
  const first = await server.handle(request, authorization);
  const second = await server.handle(request, authorization);
  const identical = JSON.stringify(first) === JSON.stringify(second);
  return {
    stateless: identical && server.sessionCount() === 0,
    sessions: server.sessionCount(),
    identical,
    reason: identical
      ? 'Two identical requests gave identical results and the server holds no sessions.'
      : 'Two identical requests gave different results (hidden per-request state).',
  };
}

/** The methods the stateless transport answers. */
export function mcpV8StatelessMethods(): readonly McpV8StatelessMethod[] {
  return MCP_V8_STATELESS_METHODS;
}
