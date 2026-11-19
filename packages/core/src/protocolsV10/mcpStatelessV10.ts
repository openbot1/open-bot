/**
 * Protocols v10 — MCP stateless core (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): spec 2026-07-28 is
 * stateless — no `initialize` handshake, no `Mcp-Session-Id`
 * header; every request carries its protocol version and
 * capabilities in `_meta`; a new server answers
 * `server/discover`. On top of the v8/v9 stateless layers,
 * v10 adds the four things the survey calls out for this
 * spec revision:
 *
 *   - OpenTelemetry trace through `_meta`: every request may
 *     carry `trace.traceId` / `spanId` (and the W3C
 *     `traceparent` string); the server echoes the trace
 *     back so a request can be followed across the host, the
 *     MCP server and the tool handler without any session.
 *   - Deterministic tool listing: `tools/list` returns tools
 *     sorted by name (byte order, stable), so two servers
 *     with the same tools produce the same listing and the
 *     host's prompt cache hits instead of missing. The
 *     listing carries a `listHash` so the client can skip
 *     re-reading an unchanged list.
 *   - Change notifications in ONE opt-in stream:
 *     `subscriptions/listen` replaces the old per-kind
 *     notification methods. A client subscribes to the kinds
 *     it wants (`tools`, `resources`, `prompts`); the server
 *     only pushes those kinds, and only while at least one
 *     listener is registered. No listener, no push.
 *   - State handles: a server that needs state issues an
 *     opaque handle (`stateHandle`) in its result; the client
 *     passes the handle back as an ordinary tool argument
 *     (`state_handle`) on the next call. The transport stays
 *     stateless — the handle is data, not a session.
 *
 * Session-only methods (`initialize`,
 * `notifications/initialized`) are still REFUSED here; the
 * legacy adapter from v8 is not re-implemented — v10 clients
 * must speak stateless, and the deprecation registry
 * (`deprecationV10.ts`) records when the legacy path goes.
 *
 * No code, text or asset from any other repo is copied here.
 * No network is opened by this module: the HTTP sender is
 * host-supplied, exactly like the v8 client.
 */

import { randomUUID } from 'node:crypto';
import {
  MCP_V10_CURRENT_VERSION,
  MCP_V10_SESSION_ONLY_METHODS,
  MCP_V10_SUBSCRIPTIONS_METHOD,
  type McpV10AppState,
} from './versionsV10';

/** Error raised by the v10 MCP stateless layer. */
export class McpV10StatelessError extends Error {
  readonly code: string;
  /** JSON-RPC error code. */
  readonly rpcCode: number;
  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = 'McpV10StatelessError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** OpenTelemetry trace carried in `_meta.trace`. */
export interface McpV10Trace {
  /** 32-hex-char trace id (W3C traceparent). */
  traceId: string;
  /** 16-hex-char span id of the caller. */
  spanId?: string;
  /** W3C `traceparent` header value (`00-<traceId>-<spanId>-<flags>`). */
  traceparent?: string;
  /** Sampling flag (`01` sampled, `00` not). */
  sampled?: boolean;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

/** Validate an OTel trace block. Returns problems (empty when valid). */
export function validateMcpV10Trace(trace: unknown): string[] {
  const problems: string[] = [];
  if (trace === undefined || trace === null) return problems;
  if (typeof trace !== 'object' || Array.isArray(trace)) {
    problems.push('trace in _meta must be an object.');
    return problems;
  }
  const t = trace as Record<string, unknown>;
  if (typeof t.traceId !== 'string' || !TRACE_ID_RE.test(t.traceId)) {
    problems.push('trace.traceId must be a 32-hex-char string.');
  }
  if (t.spanId !== undefined && (typeof t.spanId !== 'string' || !SPAN_ID_RE.test(t.spanId))) {
    problems.push('trace.spanId must be a 16-hex-char string.');
  }
  if (t.traceparent !== undefined) {
    if (typeof t.traceparent !== 'string') {
      problems.push('trace.traceparent must be a string.');
    } else {
      const m = TRACEPARENT_RE.exec(t.traceparent);
      if (!m) {
        problems.push('trace.traceparent must be a W3C traceparent (00-<traceId>-<spanId>-<flags>).');
      } else if (typeof t.traceId === 'string' && m[1] !== t.traceId) {
        problems.push('trace.traceparent traceId does not match trace.traceId.');
      } else if (typeof t.spanId === 'string' && m[2] !== t.spanId) {
        problems.push('trace.traceparent spanId does not match trace.spanId.');
      }
    }
  }
  if (t.sampled !== undefined && typeof t.sampled !== 'boolean') {
    problems.push('trace.sampled must be a boolean.');
  }
  return problems;
}

/** Build a fresh trace block (random ids, sampled by default). */
export function newMcpV10Trace(sampled = true): McpV10Trace {
  // randomUUID gives 32 hex chars once dashes are stripped.
  const full = (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 32);
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return {
    traceId: full,
    spanId,
    traceparent: `00-${full}-${spanId}-${sampled ? '01' : '00'}`,
    sampled,
  };
}

/** Format a trace block as a W3C `traceparent` header value. */
export function formatMcpV10Traceparent(trace: McpV10Trace): string {
  if (!trace.spanId) {
    throw new McpV10StatelessError('invalid-trace', -32602, 'Cannot format a traceparent without a spanId.');
  }
  return `00-${trace.traceId}-${trace.spanId}-${trace.sampled === false ? '00' : '01'}`;
}

/**
 * Parse a W3C `traceparent` header value into a trace block.
 * Returns undefined when the value is not a valid traceparent
 * (the caller then starts a fresh trace instead of failing).
 */
export function parseMcpV10Traceparent(value: unknown): McpV10Trace | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TRACEPARENT_RE.exec(value);
  if (!m) return undefined;
  return {
    traceId: m[1],
    spanId: m[2],
    traceparent: value,
    sampled: m[3] === '01',
  };
}

/**
 * Derive a child trace from a parent: same traceId (the
 * request stays in one trace across host → server → tool),
 * a fresh spanId, and a rebuilt traceparent. The sampled
 * flag is inherited unless the caller overrides it.
 */
export function childMcpV10Trace(parent: McpV10Trace, sampled?: boolean): McpV10Trace {
  const problems = validateMcpV10Trace(parent);
  if (problems.length > 0) {
    throw new McpV10StatelessError('invalid-trace', -32602, `Cannot derive a child trace: ${problems.join(' ')}`);
  }
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const useSampled = sampled ?? parent.sampled ?? true;
  return {
    traceId: parent.traceId,
    spanId,
    traceparent: `00-${parent.traceId}-${spanId}-${useSampled ? '01' : '00'}`,
    sampled: useSampled,
  };
}

/** Capabilities a client advertises inside `_meta.capabilities`. */
export interface McpV10MetaCapabilities {
  /** Extensions the client wants (negotiated per request, default off). */
  extensions?: string[];
  /** Whether the client speaks stateless HTTP. */
  statelessHttp?: boolean;
  /** Whether the client can render MCP Apps UI. */
  mcpApps?: boolean;
  /** Whether the client can poll Tasks. */
  mcpTasks?: boolean;
  /** Whether the client supports multi round-trip (input_required). */
  multiRoundTrip?: boolean;
  /** Whether the client supports tool search (defer_loading). */
  toolSearch?: boolean;
  /** Elicitation modes the client supports (kept for legacy peers). */
  elicitationModes?: string[];
}

/** Self-description carried on EVERY stateless request. */
export interface McpV10RequestMeta {
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
  capabilities?: McpV10MetaCapabilities;
  /** Extensions requested (shorthand; merged with capabilities.extensions). */
  extensions?: string[];
  /** OpenTelemetry trace for this request. */
  trace?: McpV10Trace;
  /** State handle issued by the server earlier (passed back as data). */
  stateHandle?: string;
}

/** Validate a request `_meta` block. Returns problems (empty when valid). */
export function validateMcpV10RequestMeta(meta: unknown): string[] {
  const problems: string[] = [];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    problems.push('_meta must be an object.');
    return problems;
  }
  const m = meta as Record<string, unknown>;
  if (typeof m.protocolVersion !== 'string' || m.protocolVersion.length === 0) {
    problems.push('_meta.protocolVersion is required.');
  }
  if (m.clientName !== undefined && typeof m.clientName !== 'string') {
    problems.push('_meta.clientName must be a string.');
  }
  if (m.requestId !== undefined && typeof m.requestId !== 'string') {
    problems.push('_meta.requestId must be a string.');
  }
  if (m.stateHandle !== undefined && (typeof m.stateHandle !== 'string' || m.stateHandle.length === 0)) {
    problems.push('_meta.stateHandle must be a non-empty string.');
  }
  if (m.extensions !== undefined) {
    if (!Array.isArray(m.extensions) || m.extensions.some((e) => typeof e !== 'string')) {
      problems.push('_meta.extensions must be an array of strings.');
    }
  }
  if (m.capabilities !== undefined) {
    if (typeof m.capabilities !== 'object' || m.capabilities === null || Array.isArray(m.capabilities)) {
      problems.push('_meta.capabilities must be an object.');
    } else {
      const c = m.capabilities as Record<string, unknown>;
      if (c.extensions !== undefined && (!Array.isArray(c.extensions) || c.extensions.some((e) => typeof e !== 'string'))) {
        problems.push('_meta.capabilities.extensions must be an array of strings.');
      }
      for (const flag of ['statelessHttp', 'mcpApps', 'mcpTasks', 'multiRoundTrip', 'toolSearch'] as const) {
        if (c[flag] !== undefined && typeof c[flag] !== 'boolean') {
          problems.push(`_meta.capabilities.${flag} must be a boolean.`);
        }
      }
    }
  }
  problems.push(...validateMcpV10Trace(m.trace));
  return problems;
}

/** Default capabilities the v10 client advertises in `_meta`. */
export function defaultMcpV10Capabilities(): McpV10MetaCapabilities {
  return {
    statelessHttp: true,
    mcpApps: true,
    mcpTasks: true,
    multiRoundTrip: true,
    toolSearch: true,
    extensions: [],
  };
}

/** Build a `_meta` block for one request (fresh trace per call). */
export function buildMcpV10RequestMeta(input: {
  clientName?: string;
  clientVersion?: string;
  tenant?: string;
  requestId?: string;
  capabilities?: McpV10MetaCapabilities;
  extensions?: string[];
  trace?: McpV10Trace;
  stateHandle?: string;
  protocolVersion?: string;
}): McpV10RequestMeta {
  return {
    protocolVersion: input.protocolVersion ?? MCP_V10_CURRENT_VERSION,
    clientName: input.clientName,
    clientVersion: input.clientVersion,
    tenant: input.tenant,
    requestId: input.requestId ?? `req-${randomUUID()}`,
    capabilities: input.capabilities ?? defaultMcpV10Capabilities(),
    extensions: input.extensions,
    trace: input.trace ?? newMcpV10Trace(),
    stateHandle: input.stateHandle,
  };
}

/** JSON-RPC 2.0 request on the stateless transport. */
export interface McpV10JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown> & { _meta?: McpV10RequestMeta };
}

/** JSON-RPC 2.0 response. */
export type McpV10JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string; data?: unknown } };

/** One tool the server lists (minimal shape for deterministic listing). */
export interface McpV10ToolListing {
  name: string;
  description: string;
  /** True when the tool loads lazily (defer_loading, see toolSearchV10). */
  deferLoading?: boolean;
  inputSchema?: Record<string, unknown>;
}

/**
 * Sort tools deterministically (byte order by name) and return
 * a stable hash of the listing so a client can skip re-reading
 * an unchanged list. The hash is a small FNV-1a over the sorted
 * `name|deferLoading` pairs — deterministic across processes,
 * not a security hash.
 */
export function sortMcpV10Tools(tools: readonly McpV10ToolListing[]): McpV10ToolListing[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function hashMcpV10ToolList(tools: readonly McpV10ToolListing[]): string {
  const sorted = sortMcpV10Tools(tools);
  let hash = 0x811c9dc5;
  const text = sorted.map((t) => `${t.name}|${t.deferLoading === true ? '1' : '0'}`).join('\n');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

/** Result of `tools/list` (deterministic order + cache hash). */
export interface McpV10ToolListResult {
  tools: McpV10ToolListing[];
  /** Stable hash of this listing; unchanged when the tools are unchanged. */
  listHash: string;
  /** Total tools known (may exceed the returned page). */
  total: number;
  /** Cursor for the next page (undefined when done). */
  nextCursor?: string;
}

/** A server-issued state handle (opaque to the client). */
export interface McpV10StateHandle {
  /** Opaque handle the client passes back verbatim. */
  handle: string;
  /** Server-side key the handle maps to (never sent to the client as-is). */
  scope: string;
  /** Milliseconds since epoch when issued. */
  issuedAt: number;
  /** Milliseconds since epoch when the handle expires. */
  expiresAt: number;
}

/** Issue a state handle for a scope (default TTL 10 minutes). */
export function issueMcpV10StateHandle(scope: string, ttlMs = 10 * 60 * 1000, nowMs = Date.now()): McpV10StateHandle {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new McpV10StatelessError('invalid-scope', -32602, 'State-handle scope must be a non-empty string.');
  }
  return {
    handle: `sth-${randomUUID()}`,
    scope,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
}

/** True when the handle is expired at `nowMs`. */
export function isMcpV10StateHandleExpired(handle: McpV10StateHandle, nowMs = Date.now()): boolean {
  return nowMs >= handle.expiresAt;
}

/** Change-notification kinds carried by `subscriptions/listen`. */
export const MCP_V10_NOTIFICATION_KINDS = ['tools', 'resources', 'prompts', 'tasks', 'apps'] as const;
export type McpV10NotificationKind = (typeof MCP_V10_NOTIFICATION_KINDS)[number];

/** One change notification pushed on the subscriptions stream. */
export interface McpV10Notification {
  kind: McpV10NotificationKind;
  /** What changed (`added` / `updated` / `removed`). */
  change: 'added' | 'updated' | 'removed';
  /** Name / URI of the thing that changed. */
  target: string;
  /** Milliseconds since epoch. */
  at: number;
  /** The list hash after the change (tools kind only). */
  listHash?: string;
}

/** A subscription on the single `subscriptions/listen` stream. */
export interface McpV10Subscription {
  id: string;
  kinds: McpV10NotificationKind[];
  /** Listener id the host uses to route pushes (opaque). */
  listenerId: string;
  createdAt: number;
}

/** The subscriptions hub: one stream, opt-in kinds, no listener = no push. */
export class McpV10SubscriptionHub {
  private subscriptions = new Map<string, McpV10Subscription>();
  private seq = 0;
  /** Delivered notifications (for tests / audit; capped). */
  readonly delivered: McpV10Notification[] = [];
  /** Notifications dropped because nobody subscribed (capped). */
  readonly dropped: McpV10Notification[] = [];
  private readonly maxKept = 200;

  /** Subscribe a listener to some kinds. Returns the subscription. */
  subscribe(listenerId: string, kinds: readonly McpV10NotificationKind[]): McpV10Subscription {
    if (typeof listenerId !== 'string' || listenerId.length === 0) {
      throw new McpV10StatelessError('invalid-listener', -32602, 'subscriptions/listen requires a non-empty listenerId.');
    }
    const wanted = [...new Set(kinds.filter((k) => (MCP_V10_NOTIFICATION_KINDS as readonly string[]).includes(k)))];
    if (wanted.length === 0) {
      throw new McpV10StatelessError('invalid-kinds', -32602, `subscriptions/listen requires at least one kind (${MCP_V10_NOTIFICATION_KINDS.join(', ')}).`);
    }
    this.seq += 1;
    const sub: McpV10Subscription = {
      id: `sub-${this.seq}`,
      kinds: wanted as McpV10NotificationKind[],
      listenerId,
      createdAt: Date.now(),
    };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  /** Unsubscribe. Returns true when a subscription was removed. */
  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /** All live subscriptions (copy). */
  list(): McpV10Subscription[] {
    return [...this.subscriptions.values()];
  }

  /** True when at least one listener wants this kind. */
  hasListener(kind: McpV10NotificationKind): boolean {
    for (const sub of this.subscriptions.values()) {
      if (sub.kinds.includes(kind)) return true;
    }
    return false;
  }

  /**
   * Publish a change: delivered when a listener wants the kind,
   * otherwise recorded as dropped (the server must not push to
   * nobody — the stream is opt-in).
   */
  publish(notification: Omit<McpV10Notification, 'at'> & { at?: number }): boolean {
    const full: McpV10Notification = { ...notification, at: notification.at ?? Date.now() };
    if (!this.hasListener(full.kind)) {
      this.dropped.push(full);
      if (this.dropped.length > this.maxKept) this.dropped.splice(0, this.dropped.length - this.maxKept);
      return false;
    }
    this.delivered.push(full);
    if (this.delivered.length > this.maxKept) this.delivered.splice(0, this.delivered.length - this.maxKept);
    return true;
  }

  /** How many listeners want each kind. */
  countsByKind(): Record<McpV10NotificationKind, number> {
    const out: Record<McpV10NotificationKind, number> = {
      tools: 0, resources: 0, prompts: 0, tasks: 0, apps: 0,
    };
    for (const sub of this.subscriptions.values()) {
      for (const kind of sub.kinds) out[kind] += 1;
    }
    return out;
  }
}

/** What `server/discover` returns. */
export interface McpV10DiscoverResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  capabilities: McpV10MetaCapabilities;
  extensions: string[];
  /** Methods this server speaks (stateless only). */
  methods: string[];
  /** Whether the server issues state handles. */
  stateHandles: boolean;
  /** Whether the server pushes change notifications. */
  subscriptions: boolean;
}

/** Validate a discover result (structural; never trusts a peer blindly). */
export function validateMcpV10DiscoverResult(result: unknown): string[] {
  const problems: string[] = [];
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    problems.push('server/discover result must be an object.');
    return problems;
  }
  const r = result as Record<string, unknown>;
  if (typeof r.protocolVersion !== 'string' || r.protocolVersion.length === 0) {
    problems.push('server/discover result needs protocolVersion.');
  }
  if (typeof r.serverName !== 'string' || r.serverName.length === 0) {
    problems.push('server/discover result needs serverName.');
  }
  if (!Array.isArray(r.methods) || r.methods.some((m) => typeof m !== 'string')) {
    problems.push('server/discover result needs methods as an array of strings.');
  } else if ((r.methods as string[]).some((m) => (MCP_V10_SESSION_ONLY_METHODS as readonly string[]).includes(m))) {
    problems.push('server/discover must not advertise session-only methods (initialize).');
  }
  if (typeof r.stateHandles !== 'boolean') problems.push('server/discover result needs stateHandles as a boolean.');
  if (typeof r.subscriptions !== 'boolean') problems.push('server/discover result needs subscriptions as a boolean.');
  return problems;
}

/** A tool handler the v10 server can call. */
export type McpV10ToolHandler = (
  args: Record<string, unknown>,
  meta: McpV10RequestMeta,
) => Promise<unknown> | unknown;

/** Options for the v10 stateless server. */
export interface McpV10StatelessServerOptions {
  serverName?: string;
  serverVersion?: string;
  /** Tools the server offers (listing is sorted deterministically). */
  tools?: Array<McpV10ToolListing & { handler: McpV10ToolHandler }>;
  /** Whether this server issues state handles (default true). */
  stateHandles?: boolean;
  /** Max tool arguments (bytes of JSON, default 256 KiB). */
  maxArgsBytes?: number;
}

/**
 * The v10 stateless server: answers `server/discover`,
 * `tools/list` (deterministic + hashed), `tools/call`
 * (with `_meta` validation + trace echo), and
 * `subscriptions/listen`. It holds no sessions — only a
 * tool table, a subscription hub and issued state handles.
 */
export class McpV10StatelessServer {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly stateHandlesEnabled: boolean;
  readonly maxArgsBytes: number;
  readonly subscriptions = new McpV10SubscriptionHub();
  private readonly tools = new Map<string, McpV10ToolListing & { handler: McpV10ToolHandler }>();
  private readonly handles = new Map<string, McpV10StateHandle>();
  private callCount = 0;

  constructor(options: McpV10StatelessServerOptions = {}) {
    this.serverName = options.serverName ?? 'open-bot-mcp-v10';
    this.serverVersion = options.serverVersion ?? '10.0';
    this.stateHandlesEnabled = options.stateHandles ?? true;
    this.maxArgsBytes = options.maxArgsBytes ?? 256 * 1024;
    for (const tool of options.tools ?? []) this.registerTool(tool);
  }

  /** Register (or replace) a tool. Notifies `tools` listeners. */
  registerTool(tool: McpV10ToolListing & { handler: McpV10ToolHandler }): void {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new McpV10StatelessError('invalid-tool', -32602, 'Tool name must be a non-empty string.');
    }
    if (typeof tool.handler !== 'function') {
      throw new McpV10StatelessError('invalid-tool', -32602, `Tool "${tool.name}" needs a handler function.`);
    }
    const existed = this.tools.has(tool.name);
    this.tools.set(tool.name, tool);
    this.subscriptions.publish({
      kind: 'tools',
      change: existed ? 'updated' : 'added',
      target: tool.name,
      listHash: this.toolListHash(),
    });
  }

  /** Remove a tool. Returns true when one was removed. */
  removeTool(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.subscriptions.publish({ kind: 'tools', change: 'removed', target: name, listHash: this.toolListHash() });
    }
    return removed;
  }

  /** Deterministic listing (sorted by name) + stable hash. */
  listTools(): McpV10ToolListResult {
    const tools = sortMcpV10Tools([...this.tools.values()].map(({ handler: _h, ...rest }) => rest));
    return { tools, listHash: this.toolListHash(), total: tools.length };
  }

  toolListHash(): string {
    return hashMcpV10ToolList([...this.tools.values()]);
  }

  /** Discover document for this server. */
  discover(): McpV10DiscoverResult {
    return {
      protocolVersion: MCP_V10_CURRENT_VERSION,
      serverName: this.serverName,
      serverVersion: this.serverVersion,
      capabilities: defaultMcpV10Capabilities(),
      extensions: ['tasks', 'apps', 'tool-search'],
      methods: ['server/discover', 'tools/list', 'tools/call', MCP_V10_SUBSCRIPTIONS_METHOD, 'tasks/create', 'tasks/get'],
      stateHandles: this.stateHandlesEnabled,
      subscriptions: true,
    };
  }

  /** Issue a state handle for a scope (the client passes it back as data). */
  issueStateHandle(scope: string): McpV10StateHandle {
    if (!this.stateHandlesEnabled) {
      throw new McpV10StatelessError('state-handles-disabled', -32601, 'This server does not issue state handles.');
    }
    const handle = issueMcpV10StateHandle(scope);
    this.handles.set(handle.handle, handle);
    return handle;
  }

  /** Resolve a handle the client passed back (undefined when unknown/expired). */
  resolveStateHandle(handle: string, nowMs = Date.now()): McpV10StateHandle | undefined {
    const found = this.handles.get(handle);
    if (!found) return undefined;
    if (isMcpV10StateHandleExpired(found, nowMs)) {
      this.handles.delete(handle);
      return undefined;
    }
    return found;
  }

  /** Sweep expired handles. Returns how many were dropped. */
  sweepHandles(nowMs = Date.now()): number {
    let dropped = 0;
    for (const [key, handle] of this.handles) {
      if (isMcpV10StateHandleExpired(handle, nowMs)) {
        this.handles.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Total tool calls handled (for diagnostics, not a session). */
  get totalCalls(): number {
    return this.callCount;
  }

  /**
   * Dispatch one JSON-RPC request. Session-only methods are
   * refused with a typed error; `_meta` problems are refused
   * before any handler runs; the trace block is echoed back
   * in the result `_meta` so the caller can correlate.
   */
  async dispatch(request: McpV10JsonRpcRequest): Promise<McpV10JsonRpcResponse> {
    const id = request.id;
    const fail = (code: number, message: string): McpV10JsonRpcResponse => ({
      jsonrpc: '2.0', id, error: { code, message },
    });
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return fail(-32600, 'Invalid JSON-RPC 2.0 request.');
    }
    if ((MCP_V10_SESSION_ONLY_METHODS as readonly string[]).includes(request.method)) {
      return fail(-32601, `Method "${request.method}" is session-only and refused by the stateless server (spec 2026-07-28). Use server/discover instead of initialize.`);
    }
    const meta = request.params?._meta;
    const metaProblems = validateMcpV10RequestMeta(meta);
    if (metaProblems.length > 0) {
      return fail(-32602, `Invalid _meta: ${metaProblems.join(' ')}`);
    }
    const trace = (meta as McpV10RequestMeta | undefined)?.trace;
    const withTrace = (result: unknown): McpV10JsonRpcResponse => ({
      jsonrpc: '2.0',
      id,
      result: trace ? { ...(result as Record<string, unknown>), _meta: { trace } } : result,
    });
    switch (request.method) {
      case 'server/discover': {
        const result = this.discover();
        const problems = validateMcpV10DiscoverResult(result);
        if (problems.length > 0) return fail(-32603, `Discover document invalid: ${problems.join(' ')}`);
        return withTrace(result);
      }
      case 'tools/list': {
        return withTrace(this.listTools());
      }
      case MCP_V10_SUBSCRIPTIONS_METHOD: {
        const params = request.params ?? {};
        const kinds = params.kinds;
        const listenerId = params.listenerId;
        if (!Array.isArray(kinds) || typeof listenerId !== 'string') {
          return fail(-32602, 'subscriptions/listen needs kinds (array) and listenerId (string).');
        }
        try {
          const sub = this.subscriptions.subscribe(listenerId, kinds as McpV10NotificationKind[]);
          return withTrace({ subscriptionId: sub.id, kinds: sub.kinds });
        } catch (err) {
          return fail(-32602, err instanceof Error ? err.message : String(err));
        }
      }
      case 'tools/call': {
        const params = request.params ?? {};
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== 'string' || name.length === 0) {
          return fail(-32602, 'tools/call needs name (string).');
        }
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          return fail(-32602, 'tools/call arguments must be an object.');
        }
        if (JSON.stringify(args).length > this.maxArgsBytes) {
          return fail(-32602, `tools/call arguments exceed ${this.maxArgsBytes} bytes.`);
        }
        const tool = this.tools.get(name);
        if (!tool) return fail(-32602, `Unknown tool "${name}".`);
        // A state handle passed back as a plain argument is data,
        // not a session: resolve it for the handler, then continue.
        const stateHandle = typeof args.state_handle === 'string' ? this.resolveStateHandle(args.state_handle) : undefined;
        if (typeof args.state_handle === 'string' && !stateHandle) {
          return fail(-32602, 'state_handle is unknown or expired; call server/discover again and use a fresh handle.');
        }
        this.callCount += 1;
        try {
          const result = await tool.handler(args, meta as McpV10RequestMeta);
          const out: Record<string, unknown> = { content: result };
          if (this.stateHandlesEnabled) {
            out.stateHandle = this.issueStateHandle(`tool:${name}`).handle;
          }
          return withTrace(out);
        } catch (err) {
          return fail(-32603, err instanceof Error ? err.message : String(err));
        }
      }
      default:
        return fail(-32601, `Unknown method "${request.method}".`);
    }
  }
}

/** Transport sender the v10 client uses (host-supplied; fetch or loopback). */
export type McpV10Sender = (request: McpV10JsonRpcRequest) => Promise<McpV10JsonRpcResponse>;

/** Create a loopback sender over an in-process v10 server. */
export function createLoopbackMcpV10Sender(server: McpV10StatelessServer): McpV10Sender {
  return (request) => server.dispatch(request);
}

/** Options for the v10 stateless client. */
export interface McpV10StatelessClientOptions {
  clientName?: string;
  clientVersion?: string;
  tenant?: string;
  sender: McpV10Sender;
}

/**
 * The v10 stateless client: `discover()` first, `_meta` on
 * every request, never an `initialize` call, never a session
 * id. It keeps only the discovery document, the negotiated
 * version, the last tool-list hash and any state handle the
 * server issued — no session state.
 */
export class McpV10StatelessClient {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly tenant?: string;
  private readonly sender: McpV10Sender;
  private discovered?: McpV10DiscoverResult;
  private lastListHash?: string;
  private stateHandle?: string;
  private idSeq = 0;

  constructor(options: McpV10StatelessClientOptions) {
    if (typeof options.sender !== 'function') {
      throw new McpV10StatelessError('invalid-sender', -32602, 'McpV10StatelessClient needs a sender function.');
    }
    this.clientName = options.clientName ?? 'open-bot-client-v10';
    this.clientVersion = options.clientVersion ?? '10.0';
    this.tenant = options.tenant;
    this.sender = options.sender;
  }

  /** The discovery document (undefined until discover() runs). */
  get discovery(): McpV10DiscoverResult | undefined {
    return this.discovered;
  }

  /** Last `tools/list` hash seen (undefined until listTools() runs). */
  get listHash(): string | undefined {
    return this.lastListHash;
  }

  /** State handle the server last issued (undefined when none). */
  get currentStateHandle(): string | undefined {
    return this.stateHandle;
  }

  private nextId(): string {
    this.idSeq += 1;
    return `v10-${this.idSeq}`;
  }

  private meta(): McpV10RequestMeta {
    return buildMcpV10RequestMeta({
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      tenant: this.tenant,
      stateHandle: this.stateHandle,
    });
  }

  private async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const request: McpV10JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId(),
      method,
      params: { ...params, _meta: this.meta() },
    };
    const response = await this.sender(request);
    if ('error' in response) {
      throw new McpV10StatelessError('rpc-error', response.error.code, response.error.message);
    }
    return response.result;
  }

  /** Discover the server (mandatory first call). */
  async discover(): Promise<McpV10DiscoverResult> {
    const result = (await this.send('server/discover')) as McpV10DiscoverResult;
    const problems = validateMcpV10DiscoverResult(result);
    if (problems.length > 0) {
      throw new McpV10StatelessError('invalid-discover', -32603, `Invalid server/discover result: ${problems.join(' ')}`);
    }
    if (result.protocolVersion !== MCP_V10_CURRENT_VERSION) {
      throw new McpV10StatelessError(
        'version-mismatch',
        -32603,
        `Server speaks MCP ${result.protocolVersion}, this client requires ${MCP_V10_CURRENT_VERSION}.`,
      );
    }
    this.discovered = result;
    return result;
  }

  /** List tools (deterministic order). Remembers the list hash. */
  async listTools(): Promise<McpV10ToolListResult> {
    if (!this.discovered) await this.discover();
    const result = (await this.send('tools/list')) as McpV10ToolListResult;
    if (!Array.isArray(result.tools) || typeof result.listHash !== 'string') {
      throw new McpV10StatelessError('invalid-list', -32603, 'tools/list returned an invalid result.');
    }
    const sorted = sortMcpV10Tools(result.tools);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].name !== result.tools[i].name) {
        throw new McpV10StatelessError('nondeterministic-list', -32603, 'Server tools/list is not in deterministic (sorted) order.');
      }
    }
    this.lastListHash = result.listHash;
    return result;
  }

  /** Subscribe to the single opt-in change stream. */
  async subscribe(listenerId: string, kinds: readonly McpV10NotificationKind[]): Promise<{ subscriptionId: string; kinds: McpV10NotificationKind[] }> {
    if (!this.discovered) await this.discover();
    return (await this.send(MCP_V10_SUBSCRIPTIONS_METHOD, { listenerId, kinds: [...kinds] })) as {
      subscriptionId: string;
      kinds: McpV10NotificationKind[];
    };
  }

  /**
   * Call a tool. The server may issue a state handle in the
   * result; the client stores it and passes it back as a
   * plain `state_handle` argument on the next call.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.discovered) await this.discover();
    const callArgs: Record<string, unknown> = { ...args };
    if (this.stateHandle) callArgs.state_handle = this.stateHandle;
    const result = (await this.send('tools/call', { name, arguments: callArgs })) as Record<string, unknown>;
    if (typeof result.stateHandle === 'string') this.stateHandle = result.stateHandle;
    return result.content;
  }

  /** Forget the stored state handle (e.g. after the user resets the conversation). */
  forgetStateHandle(): void {
    this.stateHandle = undefined;
  }
}

/** App state carried in the v10 discover echo (re-export for tool authors). */
export type { McpV10AppState };
