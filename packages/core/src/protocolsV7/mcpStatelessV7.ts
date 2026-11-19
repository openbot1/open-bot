/**
 * Protocols v7 — MCP stateless HTTP transport (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: MCP spec 2026-07-28 makes HTTP
 * stateless — no handshake, no session id, every request
 * self-describing and routable to any instance. This module is
 * the complete v7 stateless transport:
 *
 *   - Every request carries its own description: protocol
 *     version, client info, tenant, and (when needed) auth —
 *     in `_meta`. A request without a protocol version is
 *     refused: it is not self-describing.
 *   - Session-only methods (`initialize`,
 *     `notifications/initialized`) are REFUSED — they belong to
 *     the old stateful handshake, not to stateless HTTP.
 *   - The server keeps NO per-client state between requests:
 *     tools / resources / prompts are registered once, each call
 *     builds a fresh context from the request itself. `sessionCount()`
 *     is always 0 — the transport proves its own statelessness.
 *   - `McpV7StatelessClient` speaks the same shape over a
 *     transport interface (loopback in-process, or HTTP fetch
 *     via a host-supplied sender).
 *
 * No code, text or asset from any other repo is copied here.
 * No network is opened by this module: the HTTP sender is
 * host-supplied (fetch in `a2aClientV7.ts` style, or loopback).
 */

import { randomUUID } from 'node:crypto';
import {
  MCP_V7_CURRENT_VERSION,
  MCP_V7_SESSION_ONLY_METHODS,
  MCP_V7_STATELESS_METHODS,
  type McpV7StatelessMethod,
} from './versions';

/** Error raised by the v7 MCP stateless layer. */
export class McpV7StatelessError extends Error {
  readonly code: string;
  /** JSON-RPC error code. */
  readonly rpcCode: number;
  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = 'McpV7StatelessError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** Self-description carried on EVERY stateless request. */
export interface McpV7RequestMeta {
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
}

/** JSON-RPC 2.0 request on the stateless transport. */
export interface McpV7JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown> & { _meta?: McpV7RequestMeta };
}

/** JSON-RPC 2.0 response. */
export type McpV7JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string; data?: unknown } };

/** JSON Schema fragment for a tool's input (subset, JSON-able). */
export interface McpV7InputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A tool registered on the stateless server. */
export interface McpV7ToolDefinition {
  name: string;
  description: string;
  inputSchema: McpV7InputSchema;
  /** Free-form annotations (read-only hint, idempotency, …). */
  annotations?: Record<string, unknown>;
}

/** A resource registered on the stateless server. */
export interface McpV7ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt registered on the stateless server. */
export interface McpV7PromptDefinition {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** Result of a tool call. */
export interface McpV7ToolResult {
  /** Text / data content blocks. */
  content: { type: 'text' | 'resource'; text?: string; uri?: string; mimeType?: string }[];
  /** True when the tool itself reported an error (not a transport error). */
  isError: boolean;
  /** Structured result (when the tool returns one). */
  structuredContent?: Record<string, unknown>;
}

/** Fresh per-request context (built from the request, never stored). */
export interface McpV7RequestContext {
  meta: McpV7RequestMeta;
  tenant: string;
  /** Request id (echoed back for tracing). */
  requestId: string;
  /** Authenticated identity (when the host verified a token). */
  identity?: string;
  /** Arrival time (ms since epoch). */
  receivedAtMs: number;
}

/** A tool handler: pure function of (args, fresh context). */
export type McpV7ToolHandler = (
  args: Record<string, unknown>,
  ctx: McpV7RequestContext,
) => Promise<McpV7ToolResult> | McpV7ToolResult;

/** A resource reader: pure function of (uri, fresh context). */
export type McpV7ResourceReader = (
  uri: string,
  ctx: McpV7RequestContext,
) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> | { contents: { uri: string; mimeType: string; text: string }[] };

/** A prompt renderer: pure function of (args, fresh context). */
export type McpV7PromptRenderer = (
  args: Record<string, unknown>,
  ctx: McpV7RequestContext,
) => Promise<{ messages: { role: string; content: { type: string; text: string } }[] }> | { messages: { role: string; content: { type: string; text: string } }[] };

/** Server options. */
export interface McpV7StatelessServerOptions {
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
}

const MCP_RPC_INVALID_REQUEST = -32600;
const MCP_RPC_METHOD_NOT_FOUND = -32601;
const MCP_RPC_INVALID_PARAMS = -32602;
const MCP_RPC_INTERNAL_ERROR = -32603;
const MCP_RPC_UNAUTHORIZED = -32001;
const MCP_RPC_NOT_FOUND = -32002;
const MCP_RPC_NOT_SELF_DESCRIBING = -32005;
const MCP_RPC_SESSION_REQUIRED = -32006;

/** JSON-RPC error codes used by the v7 stateless transport. */
export const MCP_V7_STATELESS_ERROR_CODES = {
  invalidRequest: MCP_RPC_INVALID_REQUEST,
  methodNotFound: MCP_RPC_METHOD_NOT_FOUND,
  invalidParams: MCP_RPC_INVALID_PARAMS,
  internalError: MCP_RPC_INTERNAL_ERROR,
  unauthorized: MCP_RPC_UNAUTHORIZED,
  notFound: MCP_RPC_NOT_FOUND,
  notSelfDescribing: MCP_RPC_NOT_SELF_DESCRIBING,
  sessionRequired: MCP_RPC_SESSION_REQUIRED,
} as const;

/**
 * Validate the self-description of a request. Returns the
 * normalised meta, or throws McpV7StatelessError (encoded as a
 * JSON-RPC error by `handle()`).
 */
export function requireMcpV7SelfDescribing(
  request: McpV7JsonRpcRequest,
  acceptedVersions: readonly string[],
): McpV7RequestMeta {
  const meta = request.params?._meta as McpV7RequestMeta | undefined;
  if (!meta || typeof meta !== 'object') {
    throw new McpV7StatelessError(
      'not-self-describing',
      MCP_RPC_NOT_SELF_DESCRIBING,
      'Stateless request must carry _meta (protocolVersion, …): no handshake, no session id — every request describes itself.',
    );
  }
  if (typeof meta.protocolVersion !== 'string' || meta.protocolVersion.length === 0) {
    throw new McpV7StatelessError(
      'not-self-describing',
      MCP_RPC_NOT_SELF_DESCRIBING,
      'Stateless request _meta.protocolVersion is required.',
    );
  }
  if (!acceptedVersions.includes(meta.protocolVersion)) {
    throw new McpV7StatelessError(
      'unsupported-version',
      MCP_RPC_INVALID_PARAMS,
      `Unsupported MCP protocol version "${meta.protocolVersion}" (accepted: ${acceptedVersions.join(', ')}).`,
    );
  }
  return meta;
}

/** Build a self-describing request (client-side helper). */
export function buildMcpV7Request(
  method: string,
  params: Record<string, unknown> | undefined,
  meta: McpV7RequestMeta,
  id?: string | number,
): McpV7JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: id ?? `mcp-v7-${randomUUID()}`,
    method,
    params: { ...(params ?? {}), _meta: { ...meta } },
  };
}

/**
 * MCP stateless server: tools / resources / prompts registered
 * once; every request handled from its own `_meta` with a fresh
 * context. No session map, no handshake state — `sessionCount()`
 * is always 0.
 */
export class McpV7StatelessServer {
  private tools = new Map<string, { definition: McpV7ToolDefinition; handler: McpV7ToolHandler }>();
  private resources = new Map<string, { definition: McpV7ResourceDefinition; reader: McpV7ResourceReader }>();
  private prompts = new Map<string, { definition: McpV7PromptDefinition; renderer: McpV7PromptRenderer }>();
  private acceptedVersions: readonly string[];
  private tenantTokens: Map<string, string>;
  private maxArgsBytes: number;
  private defaultTenant: string;
  private nowMs: () => number;
  private handledRequests = 0;

  constructor(options: McpV7StatelessServerOptions = {}) {
    this.acceptedVersions = options.acceptedVersions ?? [MCP_V7_CURRENT_VERSION];
    this.tenantTokens = new Map(Object.entries(options.tenantTokens ?? {}));
    this.maxArgsBytes = options.maxArgsBytes ?? 1024 * 1024;
    this.defaultTenant = options.defaultTenant ?? 'default';
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Number of sessions held: always 0 (stateless by construction). */
  sessionCount(): number {
    return 0;
  }

  /** Total requests handled (a counter, not per-client state). */
  handledCount(): number {
    return this.handledRequests;
  }

  /** Register a tool (re-registering the same name replaces it). */
  registerTool(definition: McpV7ToolDefinition, handler: McpV7ToolHandler): void {
    if (!definition.name || typeof definition.name !== 'string') {
      throw new McpV7StatelessError('invalid-tool', MCP_RPC_INVALID_PARAMS, 'Tool needs a non-empty name.');
    }
    this.tools.set(definition.name, { definition: { ...definition }, handler });
  }

  /** Register a resource reader. */
  registerResource(definition: McpV7ResourceDefinition, reader: McpV7ResourceReader): void {
    if (!definition.uri || typeof definition.uri !== 'string') {
      throw new McpV7StatelessError('invalid-resource', MCP_RPC_INVALID_PARAMS, 'Resource needs a non-empty uri.');
    }
    this.resources.set(definition.uri, { definition: { ...definition }, reader });
  }

  /** Register a prompt renderer. */
  registerPrompt(definition: McpV7PromptDefinition, renderer: McpV7PromptRenderer): void {
    if (!definition.name || typeof definition.name !== 'string') {
      throw new McpV7StatelessError('invalid-prompt', MCP_RPC_INVALID_PARAMS, 'Prompt needs a non-empty name.');
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

  /**
   * Handle one stateless request. `authorization` is the raw
   * Authorization header value (when the host passes one).
   * Never throws for a bad request — errors are encoded.
   */
  async handle(
    request: unknown,
    authorization?: string,
  ): Promise<McpV7JsonRpcResponse> {
    const req = request as Partial<McpV7JsonRpcRequest> | null;
    const id = (req && typeof req === 'object' && 'id' in req
      ? (req.id as string | number)
      : `mcp-v7-${randomUUID()}`);
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0'
      || typeof req.method !== 'string' || req.method.length === 0) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: MCP_RPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object with a method.' },
      };
    }
    if ((MCP_V7_SESSION_ONLY_METHODS as readonly string[]).includes(req.method)) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_RPC_SESSION_REQUIRED,
          message: `Method "${req.method}" needs a session (stateful handshake) and is refused on the stateless transport (spec 2026-07-28).`,
        },
      };
    }
    try {
      const meta = requireMcpV7SelfDescribing(req as McpV7JsonRpcRequest, this.acceptedVersions);
      const tenant = typeof meta.tenant === 'string' && meta.tenant.length > 0 ? meta.tenant : this.defaultTenant;
      this.checkAuth(tenant, authorization);
      const ctx: McpV7RequestContext = {
        meta,
        tenant,
        requestId: meta.requestId ?? String(id),
        identity: this.identityOf(tenant, authorization),
        receivedAtMs: this.nowMs(),
      };
      const result = await this.dispatch(req.method, (req.params ?? {}) as Record<string, unknown>, ctx);
      this.handledRequests += 1;
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof McpV7StatelessError) {
        return { jsonrpc: '2.0', id, error: { code: err.rpcCode, message: err.message, data: { code: err.code } } };
      }
      return { jsonrpc: '2.0', id, error: { code: MCP_RPC_INTERNAL_ERROR, message: 'Internal server error.' } };
    }
  }

  /** Handle a batch (each request answered independently). */
  async handleBatch(
    requests: unknown[],
    authorization?: string,
  ): Promise<McpV7JsonRpcResponse[]> {
    const out: McpV7JsonRpcResponse[] = [];
    for (const req of requests) out.push(await this.handle(req, authorization));
    return out;
  }

  private checkAuth(tenant: string, authorization: string | undefined): void {
    const expected = this.tenantTokens.get(tenant);
    if (expected === undefined) return;
    if (typeof authorization !== 'string') {
      throw new McpV7StatelessError('unauthorized', MCP_RPC_UNAUTHORIZED, `Tenant "${tenant}" needs an Authorization header.`);
    }
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
    if (token.length === 0 || token !== expected) {
      throw new McpV7StatelessError('unauthorized', MCP_RPC_UNAUTHORIZED, `Bad token for tenant "${tenant}".`);
    }
  }

  private identityOf(tenant: string, authorization: string | undefined): string | undefined {
    if (this.tenantTokens.has(tenant) && authorization) return `tenant:${tenant}`;
    return undefined;
  }

  private checkArgsSize(params: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf-8');
    if (bytes > this.maxArgsBytes) {
      throw new McpV7StatelessError(
        'args-too-large',
        MCP_RPC_INVALID_PARAMS,
        `Tool arguments are ${bytes} bytes (max ${this.maxArgsBytes}).`,
      );
    }
  }

  private requireParam(params: Record<string, unknown>, name: string): unknown {
    const value = params[name];
    if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
      throw new McpV7StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, `Param "${name}" is required.`);
    }
    return value;
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    ctx: McpV7RequestContext,
  ): Promise<unknown> {
    switch (method as McpV7StatelessMethod) {
      case 'ping':
        return { ok: true, protocolVersion: ctx.meta.protocolVersion, tenant: ctx.tenant, requestId: ctx.requestId };
      case 'tools/list':
        return { tools: [...this.tools.values()].map((t) => t.definition) };
      case 'tools/call': {
        this.checkArgsSize(params);
        const name = this.requireParam(params, 'name') as string;
        const entry = this.tools.get(name);
        if (!entry) {
          throw new McpV7StatelessError('tool-not-found', MCP_RPC_NOT_FOUND, `Tool "${name}" is not registered.`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new McpV7StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, 'Param "arguments" must be an object.');
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
          throw new McpV7StatelessError('resource-not-found', MCP_RPC_NOT_FOUND, `Resource "${uri}" is not registered.`);
        }
        return entry.reader(uri, ctx);
      }
      case 'prompts/list':
        return { prompts: [...this.prompts.values()].map((p) => p.definition) };
      case 'prompts/get': {
        const name = this.requireParam(params, 'name') as string;
        const entry = this.prompts.get(name);
        if (!entry) {
          throw new McpV7StatelessError('prompt-not-found', MCP_RPC_NOT_FOUND, `Prompt "${name}" is not registered.`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new McpV7StatelessError('invalid-params', MCP_RPC_INVALID_PARAMS, 'Param "arguments" must be an object.');
        }
        return entry.renderer(args, ctx);
      }
      default:
        throw new McpV7StatelessError(
          'method-not-found',
          MCP_RPC_METHOD_NOT_FOUND,
          `Method "${method}" is not part of the MCP stateless surface (known: ${MCP_V7_STATELESS_METHODS.join(', ')}).`,
        );
    }
  }

  /** Validate tool arguments against the tool's required fields. */
  private validateToolArgs(definition: McpV7ToolDefinition, args: Record<string, unknown>): void {
    const required = definition.inputSchema.required ?? [];
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        throw new McpV7StatelessError(
          'invalid-params',
          MCP_RPC_INVALID_PARAMS,
          `Tool "${definition.name}" needs argument "${field}".`,
        );
      }
    }
  }
}

/** A sender the stateless client posts requests through (host-supplied). */
export type McpV7StatelessSender = (
  request: McpV7JsonRpcRequest,
  authorization?: string,
) => Promise<McpV7JsonRpcResponse>;

/** Client options. */
export interface McpV7StatelessClientOptions {
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
}

/**
 * MCP stateless client: builds a fresh self-describing request
 * for every call (no handshake, no stored session) and posts it
 * through the host-supplied sender.
 */
export class McpV7StatelessClient {
  private sender: McpV7StatelessSender;
  private options: McpV7StatelessClientOptions;
  private requestSeq = 0;

  constructor(sender: McpV7StatelessSender, options: McpV7StatelessClientOptions = {}) {
    this.sender = sender;
    this.options = { ...options };
  }

  /** Build the `_meta` stamped on every request. */
  meta(): McpV7RequestMeta {
    return {
      protocolVersion: this.options.protocolVersion ?? MCP_V7_CURRENT_VERSION,
      clientName: this.options.clientName ?? 'open-bot',
      clientVersion: this.options.clientVersion ?? '1.38',
      tenant: this.options.tenant ?? 'default',
      requestId: `req-${++this.requestSeq}-${randomUUID()}`,
    };
  }

  /** Ping the server (also proves the request is self-describing). */
  async ping(): Promise<{ ok: boolean; protocolVersion: string; tenant: string; requestId: string }> {
    return this.call('ping', {});
  }

  /** List the server's tools. */
  async listTools(): Promise<{ tools: McpV7ToolDefinition[] }> {
    return this.call('tools/list', {});
  }

  /** Call a tool (arguments are validated server-side too). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpV7ToolResult> {
    return this.call('tools/call', { name, arguments: args });
  }

  /** List the server's resources. */
  async listResources(): Promise<{ resources: McpV7ResourceDefinition[] }> {
    return this.call('resources/list', {});
  }

  /** Read a resource. */
  async readResource(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
    return this.call('resources/read', { uri });
  }

  /** List the server's prompts. */
  async listPrompts(): Promise<{ prompts: McpV7PromptDefinition[] }> {
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
    const request = buildMcpV7Request(method, params, this.meta());
    const authorization = this.options.bearerToken ? `Bearer ${this.options.bearerToken}` : undefined;
    const response = await this.sender(request, authorization);
    if ('error' in response) {
      throw new McpV7StatelessError(
        'rpc-error',
        response.error.code,
        `Call ${method} failed: ${response.error.message}`,
      );
    }
    return response.result as T;
  }
}

/** Create a loopback sender over a server (tests + local hosts). */
export function createLoopbackMcpV7Sender(server: McpV7StatelessServer): McpV7StatelessSender {
  return (request, authorization) => server.handle(request, authorization);
}

/**
 * Prove a server is stateless: two identical requests must give
 * identical results, and the server must hold zero sessions.
 * Returns the check result (never throws).
 */
export async function checkMcpV7Stateless(
  server: McpV7StatelessServer,
  request: McpV7JsonRpcRequest,
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
export function mcpV7StatelessMethods(): readonly McpV7StatelessMethod[] {
  return MCP_V7_STATELESS_METHODS;
}
