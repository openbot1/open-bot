/**
 * Protocols v2 — MCP stateless client, wave v1.17 (Team T2).
 *
 * Idea only, learned from the public MCP spec 2026-07-28
 * description in docs/repo-survey-v117.md section 3: the spec
 * moved from stateful session-based to stateless request/
 * response — every request carries its own protocol version
 * and capabilities in `_meta` and no session id is kept.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the existing stateless layers without
 * touching them:
 *  - `mcp/stateless.ts` — `server/discover` document, per-
 *    request `_meta` envelope (`buildStatelessMeta`);
 *  - `mcp/statelessClient.ts` — auto-negotiation (`discover`
 *    first, fall back to the `initialize` handshake for
 *    pre-2.0 servers) and `_meta` attachment.
 * v117 adds the client that actually *uses* those pieces for
 * real work: a `StatelessMcpClientV117` that drives an injected
 * transport, speaks tools/resources/prompts, times out and
 * retries transient failures, and — by construction — never
 * stores a session id: there is no session field anywhere in
 * this class, and `negotiation` records which path was taken
 * so the UI can say exactly what happened.
 *
 * Compatibility: the transport is a plain function surface
 * (`request(method, params)`), so the existing MCP clients in
 * this repo (`mcp/client.ts`: `StdioMcpClient`,
 * `StreamableHttpMcpClient`) can be wrapped by passing their
 * request function — no parallel client hierarchy is created.
 * A server that does not understand `server/discover` still
 * works through the handshake fallback in `connect('auto')`.
 */

import {
  MCP_PROTOCOL_VERSION_2026,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
} from '../mcp/stateless';
import {
  attachStatelessMetaToParams,
  buildRequestStatelessMeta,
  negotiateStatelessConnection,
  type StatelessNegotiatedMode,
  type StatelessNegotiation,
  type StatelessNegotiableClient,
} from '../mcp/statelessClient';

/** MCP 2026-07-28 protocol version this client speaks. */
export const MCP_V117_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION_2026;
/** Default per-request timeout. */
export const MCP_V117_DEFAULT_TIMEOUT_MS = 30_000;
/** Default transient-failure retries (1 retry = 2 attempts total). */
export const MCP_V117_DEFAULT_MAX_RETRIES = 1;

/** Error raised by the v117 stateless client. */
export class McpStatelessV117Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpStatelessV117Error';
    this.code = code;
  }
}

/**
 * Minimal transport the client drives. `request` sends one
 * JSON-RPC-style request and resolves with its result (or
 * rejects with the server error). `notify`, when the transport
 * supports it, sends a fire-and-forget notification.
 * The transport owns the wire (stdio, HTTP, loopback); this
 * client owns only the stateless envelope around it.
 */
export interface StatelessMcpTransport {
  request: (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
  notify?: (method: string, params?: Record<string, unknown>) => Promise<void> | void;
}

/** How the client connects (see `mcp/statelessClient.ts`). */
export type McpV117ConnectMode = boolean | 'auto';

/** Options for one client. */
export interface StatelessMcpClientV117Options {
  /** Protocol version to declare (default 2026-07-28). */
  protocolVersion?: string;
  /** Capabilities declared in every request's `_meta`. */
  capabilities?: StatelessClientCapabilities;
  /** Per-request timeout in ms (default 30_000; 0 = no timeout). */
  timeoutMs?: number;
  /** Transient-failure retries (default 1). */
  maxRetries?: number;
  /** Base delay between retries in ms (default 100, doubled each retry). */
  retryBaseDelayMs?: number;
  /** Client name reported to the server. */
  clientName?: string;
  /** Client version reported to the server. */
  clientVersion?: string;
}

/** One page of a `tools/list` result (cursor pagination). */
export interface McpV117ToolPage {
  tools: McpV117Tool[];
  /** Cursor for the next page (absent = last page). */
  nextCursor?: string;
}

/** A server notification delivered to the client. */
export interface McpV117Notification {
  method: string;
  params?: Record<string, unknown>;
}

/** Handler for one notification method. */
export type McpV117NotificationHandler = (notification: McpV117Notification) => void;

/** One MCP tool, as listed by the server. */
export interface McpV117Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** One MCP resource, as listed by the server. */
export interface McpV117Resource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** One MCP prompt, as listed by the server. */
export interface McpV117Prompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Result of a `tools/call`. */
export interface McpV117ToolCallResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Connection state of the client. */
export type McpV117ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Stateless MCP client (spec 2026-07-28).
 *
 * State kept per client: connection state, the last
 * negotiation outcome, a monotonic request counter, and the
 * declared capabilities. Deliberately NOT kept: any session
 * id, any handshake state, any per-server session cache —
 * every request is self-contained (`_meta` carries the
 * protocol version + capabilities), so a client can be
 * dropped and recreated mid-conversation without losing the
 * ability to talk to the server.
 */
export class StatelessMcpClientV117 {
  private readonly transport: StatelessMcpTransport;
  private readonly protocolVersion: string;
  private readonly capabilities: StatelessClientCapabilities;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private state: McpV117ConnectionState = 'disconnected';
  private negotiation: StatelessNegotiation | null = null;
  private requestCounter = 0;
  private requestLog: Array<{ id: number; method: string; atMs: number; ms: number; ok: boolean }> = [];
  private readonly notificationHandlers = new Map<string, Set<McpV117NotificationHandler>>();
  private readonly wildcardHandlers = new Set<McpV117NotificationHandler>();
  private notificationsReceived = 0;

  constructor(transport: StatelessMcpTransport, options: StatelessMcpClientV117Options = {}) {
    this.transport = transport;
    this.protocolVersion = options.protocolVersion ?? MCP_V117_PROTOCOL_VERSION;
    this.capabilities = options.capabilities ?? { multiRoundTrip: true, tasks: true, apps: true };
    this.timeoutMs = options.timeoutMs ?? MCP_V117_DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MCP_V117_DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.clientName = options.clientName ?? 'open-bot';
    this.clientVersion = options.clientVersion ?? '1.17.0';
  }

  /** Current connection state. */
  connectionState(): McpV117ConnectionState {
    return this.state;
  }

  /** Last negotiation outcome (null before `connect`). */
  lastNegotiation(): StatelessNegotiation | null {
    return this.negotiation ? { ...this.negotiation } : null;
  }

  /** Which connection path was negotiated ('stateless' | 'handshake'). */
  negotiatedMode(): StatelessNegotiatedMode | null {
    return this.negotiation ? this.negotiation.mode : null;
  }

  /** True when the client speaks stateless (no handshake was needed). */
  isStateless(): boolean {
    return this.negotiation?.mode === 'stateless';
  }

  /** Protocol version in effect (negotiated, else declared). */
  effectiveProtocolVersion(): string {
    return this.negotiation?.protocolVersion ?? this.protocolVersion;
  }

  /** Server identity from the discovery document (null before connect / on handshake fallback). */
  serverInfo(): { name: string; version: string } | null {
    return this.negotiation?.discovered?.serverInfo ?? null;
  }

  /** How many server notifications this client has delivered to handlers. */
  notificationCount(): number {
    return this.notificationsReceived;
  }

  /**
   * Register a handler for one notification method (e.g.
   * `notifications/tools/list_changed`). Pass `'*'` to receive
   * every notification. Returns an unsubscribe fn. Transports
   * deliver notifications by calling `handleNotification`;
   * a client with no handler for a method simply drops it.
   */
  onNotification(method: string, handler: McpV117NotificationHandler): () => void {
    if (method === '*') {
      this.wildcardHandlers.add(handler);
      return () => {
        this.wildcardHandlers.delete(handler);
      };
    }
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      this.notificationHandlers.get(method)?.delete(handler);
    };
  }

  /**
   * Deliver a server notification to the registered handlers.
   * Called by the transport adapter when the server pushes a
   * notification (stateless servers push over their own channel;
   * this client never polls for them). Unknown methods with no
   * handler are dropped, never thrown.
   */
  handleNotification(notification: McpV117Notification): void {
    if (!notification || typeof notification.method !== 'string' || !notification.method) return;
    this.notificationsReceived += 1;
    for (const handler of this.notificationHandlers.get(notification.method) ?? []) handler(notification);
    for (const handler of this.wildcardHandlers) handler(notification);
  }

  /** Request log (method, duration, outcome) — newest last, capped at 200. */
  recentRequests(): Array<{ id: number; method: string; atMs: number; ms: number; ok: boolean }> {
    return this.requestLog.map((r) => ({ ...r }));
  }

  /**
   * Connect to the server. `'auto'` (recommended) tries
   * `server/discover` first and falls back to the `initialize`
   * handshake for pre-2.0 servers; `true` is stateless-only;
   * `false` is handshake-only. The negotiation outcome is
   * recorded; no session id is stored either way.
   */
  async connect(mode: McpV117ConnectMode = 'auto'): Promise<StatelessNegotiation> {
    if (this.state === 'connected') return this.negotiation!;
    this.state = 'connecting';
    const negotiable: StatelessNegotiableClient = {
      discover: async () => {
        const raw = await this.rawRequest('server/discover', { _meta: this.metaFor() });
        if (raw === null || raw === undefined) return null;
        if (typeof raw !== 'object' || Array.isArray(raw)) return null;
        const doc = raw as Record<string, unknown>;
        return {
          protocolVersion: typeof doc['protocolVersion'] === 'string' ? (doc['protocolVersion'] as string) : this.protocolVersion,
          capabilities: ((doc['capabilities'] as Record<string, unknown>) ?? {}) as ServerDiscoverResult['capabilities'],
          serverInfo: (doc['serverInfo'] as { name: string; version: string }) ?? { name: 'unknown', version: '' },
          ...(Array.isArray(doc['extensions']) ? { extensions: doc['extensions'] as string[] } : {}),
        };
      },
      initialize: async () => {
        const raw = await this.rawRequest('initialize', {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: this.clientName, version: this.clientVersion },
        });
        if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['protocolVersion'] === 'string') {
          return { protocolVersion: (raw as Record<string, unknown>)['protocolVersion'] as string };
        }
        return {};
      },
    };
    try {
      this.negotiation = await negotiateStatelessConnection(negotiable, mode, {
        fallbackVersion: this.protocolVersion,
      });
    } catch (err) {
      this.state = 'disconnected';
      throw err instanceof McpStatelessV117Error
        ? err
        : new McpStatelessV117Error('CONNECT_FAILED', err instanceof Error ? err.message : String(err));
    }
    this.state = 'connected';
    return { ...this.negotiation };
  }

  /** Disconnect (forgets the negotiation; nothing server-side to close — stateless). */
  disconnect(): void {
    this.state = 'disconnected';
    this.negotiation = null;
  }

  /** `ping` — the server answers with an empty result when alive. */
  async ping(): Promise<boolean> {
    this.requireConnected();
    await this.call('ping');
    return true;
  }

  /** `tools/list` — tools the server offers. */
  async listTools(): Promise<McpV117Tool[]> {
    this.requireConnected();
    const tools: McpV117Tool[] = [];
    let cursor: string | undefined;
    // A server may page its tool list; walk at most 10 pages.
    for (let page = 0; page < 10; page += 1) {
      const result = await this.listToolsPage(cursor);
      tools.push(...result.tools);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** One page of `tools/list` (cursor pagination, stateless — the cursor rides in the request). */
  async listToolsPage(cursor?: string): Promise<McpV117ToolPage> {
    this.requireConnected();
    const raw = await this.call('tools/list', cursor ? { cursor } : {});
    const tools = (raw as Record<string, unknown>)?.['tools'];
    if (!Array.isArray(tools)) {
      throw new McpStatelessV117Error('BAD_RESPONSE', 'tools/list did not return a tools array');
    }
    const parsed = tools.map((t) => {
      const rec = t as Record<string, unknown>;
      if (typeof rec['name'] !== 'string' || !rec['name']) {
        throw new McpStatelessV117Error('BAD_RESPONSE', 'tools/list returned a tool without a name');
      }
      return {
        name: rec['name'] as string,
        ...(typeof rec['description'] === 'string' ? { description: rec['description'] as string } : {}),
        ...(rec['inputSchema'] && typeof rec['inputSchema'] === 'object'
          ? { inputSchema: rec['inputSchema'] as Record<string, unknown> }
          : {}),
        ...(rec['annotations'] && typeof rec['annotations'] === 'object'
          ? { annotations: rec['annotations'] as Record<string, unknown> }
          : {}),
      };
    });
    const nextCursor = (raw as Record<string, unknown>)?.['nextCursor'];
    return {
      tools: parsed,
      ...(typeof nextCursor === 'string' && nextCursor ? { nextCursor } : {}),
    };
  }

  /** `tools/call` — call one tool with arguments. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpV117ToolCallResult> {
    this.requireConnected();
    if (!name.trim()) throw new McpStatelessV117Error('INVALID_TOOL', 'callTool needs a tool name');
    const raw = await this.call('tools/call', { name, arguments: args });
    const rec = raw as Record<string, unknown>;
    if (!rec || !Array.isArray(rec['content'])) {
      throw new McpStatelessV117Error('BAD_RESPONSE', `tools/call ${name} did not return content`);
    }
    return {
      content: rec['content'] as unknown[],
      ...(typeof rec['isError'] === 'boolean' ? { isError: rec['isError'] as boolean } : {}),
      ...(rec['structuredContent'] && typeof rec['structuredContent'] === 'object'
        ? { structuredContent: rec['structuredContent'] as Record<string, unknown> }
        : {}),
    };
  }

  /** `resources/list` — resources the server offers. */
  async listResources(): Promise<McpV117Resource[]> {
    this.requireConnected();
    const raw = await this.call('resources/list');
    const resources = (raw as Record<string, unknown>)?.['resources'];
    if (!Array.isArray(resources)) {
      throw new McpStatelessV117Error('BAD_RESPONSE', 'resources/list did not return a resources array');
    }
    return resources.map((r) => {
      const rec = r as Record<string, unknown>;
      if (typeof rec['uri'] !== 'string' || !rec['uri']) {
        throw new McpStatelessV117Error('BAD_RESPONSE', 'resources/list returned a resource without a uri');
      }
      return {
        uri: rec['uri'] as string,
        ...(typeof rec['name'] === 'string' ? { name: rec['name'] as string } : {}),
        ...(typeof rec['description'] === 'string' ? { description: rec['description'] as string } : {}),
        ...(typeof rec['mimeType'] === 'string' ? { mimeType: rec['mimeType'] as string } : {}),
      };
    });
  }

  /** `resources/read` — read one resource (all its contents). */
  async readResource(uri: string): Promise<unknown[]> {
    this.requireConnected();
    if (!uri.trim()) throw new McpStatelessV117Error('INVALID_RESOURCE', 'readResource needs a uri');
    const raw = await this.call('resources/read', { uri });
    const contents = (raw as Record<string, unknown>)?.['contents'];
    if (!Array.isArray(contents)) {
      throw new McpStatelessV117Error('BAD_RESPONSE', `resources/read ${uri} did not return contents`);
    }
    return contents as unknown[];
  }

  /** `prompts/list` — prompts the server offers. */
  async listPrompts(): Promise<McpV117Prompt[]> {
    this.requireConnected();
    const raw = await this.call('prompts/list');
    const prompts = (raw as Record<string, unknown>)?.['prompts'];
    if (!Array.isArray(prompts)) {
      throw new McpStatelessV117Error('BAD_RESPONSE', 'prompts/list did not return a prompts array');
    }
    return prompts.map((p) => {
      const rec = p as Record<string, unknown>;
      if (typeof rec['name'] !== 'string' || !rec['name']) {
        throw new McpStatelessV117Error('BAD_RESPONSE', 'prompts/list returned a prompt without a name');
      }
      return {
        name: rec['name'] as string,
        ...(typeof rec['description'] === 'string' ? { description: rec['description'] as string } : {}),
        ...(Array.isArray(rec['arguments']) ? { arguments: rec['arguments'] as McpV117Prompt['arguments'] } : {}),
      };
    });
  }

  /** `prompts/get` — expand one prompt with arguments. */
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.requireConnected();
    if (!name.trim()) throw new McpStatelessV117Error('INVALID_PROMPT', 'getPrompt needs a prompt name');
    return this.call('prompts/get', { name, arguments: args });
  }

  /**
   * Send a notification (fire-and-forget). Requires a transport
   * that supports `notify`; a request-only transport refuses
   * loudly instead of silently dropping the notification.
   */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    this.requireConnected();
    if (!this.transport.notify) {
      throw new McpStatelessV117Error(
        'NOTIFY_UNSUPPORTED',
        'This transport cannot send notifications — notifications would be silently dropped',
      );
    }
    await this.transport.notify(method, attachStatelessMetaToParams(params, this.metaFor()));
  }

  /**
   * Subscribe to a resource (`resources/subscribe`): the server
   * sends `notifications/resources/updated` when it changes, and
   * this client fans it out to `handler`. Returns an unsubscribe
   * fn that also sends `resources/unsubscribe` (best-effort —
   * a failure to unsubscribe never throws, the local handler is
   * removed either way).
   */
  async subscribeResource(
    uri: string,
    handler: (notification: McpV117Notification) => void,
  ): Promise<() => Promise<void>> {
    this.requireConnected();
    if (!uri.trim()) throw new McpStatelessV117Error('INVALID_RESOURCE', 'subscribeResource needs a uri');
    await this.call('resources/subscribe', { uri });
    const off = this.onNotification('notifications/resources/updated', (notification) => {
      const params = notification.params ?? {};
      if (params['uri'] === uri) handler(notification);
    });
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      off();
      try {
        await this.call('resources/unsubscribe', { uri });
      } catch {
        // Best-effort: the server may already be gone.
      }
    };
  }

  /**
   * One stateless request: attach `_meta` (protocol version +
   * capabilities), time it out, retry transient failures.
   * A request id is assigned per attempt for the log only —
   * it is never sent as session state.
   */
  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const withMeta = attachStatelessMetaToParams(params, this.metaFor());
    return this.withRetry(method, () => this.rawRequest(method, withMeta));
  }

  /** The `_meta` envelope for one request. */
  private metaFor(): ReturnType<typeof buildRequestStatelessMeta> {
    return buildRequestStatelessMeta({
      protocolVersion: this.effectiveProtocolVersion(),
      capabilities: this.capabilities,
    });
  }

  /** One transport round-trip with timeout + logging. */
  private async rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requestCounter += 1;
    const id = this.requestCounter;
    const started = Date.now();
    const run = async (): Promise<unknown> => {
      if (this.timeoutMs <= 0) return this.transport.request(method, params);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.transport.request(method, params),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new McpStatelessV117Error('TIMEOUT', `${method} timed out after ${this.timeoutMs}ms`)),
              this.timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      const result = await run();
      this.logRequest(id, method, started, true);
      return result;
    } catch (err) {
      this.logRequest(id, method, started, false);
      throw err;
    }
  }

  /** Retry transient failures (server -32603 / timeouts) with backoff. */
  private async withRetry<T>(method: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        attempt += 1;
        if (attempt > this.maxRetries || !isTransientMcpError(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, this.retryBaseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  private logRequest(id: number, method: string, started: number, ok: boolean): void {
    this.requestLog.push({ id, method, atMs: started, ms: Date.now() - started, ok });
    while (this.requestLog.length > 200) this.requestLog.shift();
  }

  private requireConnected(): void {
    if (this.state !== 'connected') {
      throw new McpStatelessV117Error('NOT_CONNECTED', 'Stateless MCP client is not connected — call connect() first');
    }
  }
}

/** Transient = worth one retry: timeouts and internal server errors. */
export function isTransientMcpError(err: unknown): boolean {
  if (err instanceof McpStatelessV117Error) return err.code === 'TIMEOUT';
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    if (rec['code'] === -32603 || rec['code'] === 'ECONNRESET' || rec['code'] === 'ETIMEDOUT') return true;
    const message = typeof rec['message'] === 'string' ? (rec['message'] as string) : '';
    if (/ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return true;
  }
  return false;
}

/**
 * Wrap an existing MCP client's request function as a stateless
 * transport — the compat point for the clients already in this
 * repo (`mcp/client.ts`). The wrapper adds nothing stateful:
 * it forwards method + params and returns the result.
 */
export function statelessTransportFromRequest(
  request: StatelessMcpTransport['request'],
  notify?: StatelessMcpTransport['notify'],
): StatelessMcpTransport {
  return notify ? { request, notify } : { request };
}
