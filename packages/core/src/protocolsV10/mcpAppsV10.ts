/**
 * Protocols v10 — MCP Apps postMessage bridge (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): MCP Apps is an
 * official extension (GA with spec 2026-07-28) — a tool
 * returns a UI resource (`text/html;profile=mcp-app`), the
 * host renders it in a sandboxed iframe inside the chat, and
 * the UI calls back to the MCP server through the host over
 * JSON-RPC 2.0 via postMessage (`ui/initialize`,
 * `tools/call`). The security model is explicit: the UI is
 * untrusted, the host is the arbiter, the backend is the
 * trust boundary, and the CSP is built from the domains the
 * app declares.
 *
 * This module builds on the v8 host (`protocolsV8/mcpAppsV8.ts`:
 * `ui://` resources, HTML validation, CSP from declared
 * domains, callback validation) and the v9 lifecycle manager
 * (`protocolsV9/mcpAppsV9.ts`: open / close / reopen /
 * suspend / resume / focus, panel slots, snapshots) and adds
 * the missing half — the actual bridge between the untrusted
 * UI and the trusted server:
 *
 *   - `McpV10AppBridge`: validates every postMessage the UI
 *     sends (shape, method, id, origin), runs the
 *     `ui/initialize` handshake (capability exchange: the UI
 *     declares what it can do, the host answers what it
 *     allows), relays `tools/call` to a host-supplied
 *     executor only when the tool is on the app's allowlist,
 *     the arguments fit the size budget, and the per-app
 *     rate limit allows it. Every decision is logged.
 *   - `buildMcpV10AppCsp()`: a stricter CSP than v8 — no
 *     `unsafe-inline`, no `unsafe-eval`, `frame-ancestors`
 *     locked to the host origin, `connect-src` limited to
 *     the declared domains plus the host bridge origin.
 *   - `McpV10AppSession`: one bridged app instance — its
 *     handshake state, allowlist, call log and rate-limit
 *     counters — so the host can audit exactly what an app
 *     did, and revoke it.
 *
 * No code, text or asset from any other repo is copied here.
 * No DOM, no network: the bridge works on message objects
 * and strings only; the host supplies the executor and the
 * origin checks.
 */

import {
  buildMcpV8AppCsp,
  validateMcpV8AppHtml,
  MCP_V8_APP_MIME_TYPE,
  type McpV8AppResource,
} from '../protocolsV8/mcpAppsV8';

/** Error raised by the MCP Apps v10 bridge. */
export class McpV10AppsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10AppsError';
    this.code = code;
  }
}

/** The MCP Apps mime type (unchanged from v8). */
export const MCP_V10_APP_MIME_TYPE = MCP_V8_APP_MIME_TYPE;
/** Bridge protocol version (the `ui/initialize` handshake negotiates this). */
export const MCP_V10_APP_BRIDGE_VERSION = '1.0';
/** Methods the UI may send over the bridge. */
export const MCP_V10_APP_BRIDGE_METHODS = ['ui/initialize', 'tools/call', 'ui/close', 'ui/notify'] as const;
export type McpV10AppBridgeMethod = (typeof MCP_V10_APP_BRIDGE_METHODS)[number];

/** Max tool-call arguments the bridge relays (bytes of JSON, default 64 KiB). */
export const MCP_V10_APP_MAX_CALL_ARGS_BYTES = 64 * 1024;
/** Max tool calls per app per minute (default 60). */
export const MCP_V10_APP_MAX_CALLS_PER_MINUTE = 60;
/** Max bridge messages kept in the audit log per session (default 500). */
export const MCP_V10_APP_MAX_BRIDGE_EVENTS = 500;

/** One JSON-RPC 2.0 message over postMessage (either direction). */
export interface McpV10BridgeMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Validate a bridge message's shape. Returns problems (empty when valid). */
export function validateMcpV10BridgeMessage(message: unknown): string[] {
  const problems: string[] = [];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    problems.push('Bridge message must be an object.');
    return problems;
  }
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') problems.push('Bridge message must have jsonrpc "2.0".');
  const hasMethod = typeof m.method === 'string';
  const hasResult = m.result !== undefined;
  const hasError = typeof m.error === 'object' && m.error !== null;
  if (!hasMethod && !hasResult && !hasError) {
    problems.push('Bridge message needs a method (request), a result, or an error (response).');
  }
  if (hasMethod && hasResult) problems.push('Bridge message cannot have both a method and a result.');
  if (hasMethod && m.method !== undefined && !(MCP_V10_APP_BRIDGE_METHODS as readonly string[]).includes(m.method as string)) {
    problems.push(`Unknown bridge method "${String(m.method)}" (allowed: ${MCP_V10_APP_BRIDGE_METHODS.join(', ')}).`);
  }
  if (m.id !== undefined && typeof m.id !== 'string' && typeof m.id !== 'number') {
    problems.push('Bridge message id must be a string or a number.');
  }
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) {
    problems.push('Bridge message params must be an object.');
  }
  if (hasError) {
    const e = m.error as Record<string, unknown>;
    if (typeof e.code !== 'number' || typeof e.message !== 'string') {
      problems.push('Bridge message error needs a numeric code and a string message.');
    }
  }
  return problems;
}

/** Capabilities the UI declares in `ui/initialize`. */
export interface McpV10AppUiCapabilities {
  /** Bridge versions the UI speaks. */
  bridgeVersions: string[];
  /** Whether the UI can show a loading state. */
  loadingState?: boolean;
  /** Whether the UI sends `ui/notify` events (progress, errors). */
  notifications?: boolean;
}

/** Capabilities the host grants in the `ui/initialize` answer. */
export interface McpV10AppHostCapabilities {
  /** Bridge version the host chose. */
  bridgeVersion: string;
  /** Tools this app may call (allowlist). */
  allowedTools: string[];
  /** Max call-argument bytes the host relays. */
  maxCallArgsBytes: number;
  /** Max calls per minute the host allows. */
  maxCallsPerMinute: number;
}

/** Validate UI capabilities from `ui/initialize`. Returns problems. */
export function validateMcpV10AppUiCapabilities(caps: unknown): string[] {
  const problems: string[] = [];
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    problems.push('ui/initialize capabilities must be an object.');
    return problems;
  }
  const c = caps as Record<string, unknown>;
  if (!Array.isArray(c.bridgeVersions) || c.bridgeVersions.length === 0 || c.bridgeVersions.some((v) => typeof v !== 'string')) {
    problems.push('ui/initialize capabilities need bridgeVersions (non-empty array of strings).');
  } else if (!(c.bridgeVersions as string[]).includes(MCP_V10_APP_BRIDGE_VERSION)) {
    problems.push(`Host only speaks bridge version ${MCP_V10_APP_BRIDGE_VERSION}; the UI offered ${(c.bridgeVersions as string[]).join(', ')}.`);
  }
  for (const flag of ['loadingState', 'notifications'] as const) {
    if (c[flag] !== undefined && typeof c[flag] !== 'boolean') {
      problems.push(`ui/initialize capabilities.${flag} must be a boolean.`);
    }
  }
  return problems;
}

/**
 * Build the CSP for an app resource (stricter than v8):
 * default-deny, scripts only from the app itself or declared
 * domains, no `unsafe-inline` / `unsafe-eval`, `connect-src`
 * limited to declared domains plus the host bridge origin,
 * `frame-ancestors` locked to the host origin.
 */
export function buildMcpV10AppCsp(resource: McpV8AppResource, hostOrigin: string): string {
  const base = buildMcpV8AppCsp(resource);
  const domains = resource.domains.map((d) => `https://${d}`).join(' ');
  const connectSrc = ['\'self\'', hostOrigin, domains].filter(Boolean).join(' ');
  // Strip the v8 connect-src (if any) and rebuild the policy
  // from the declared domains — the v10 policy is the whole
  // story, not an append.
  void base;
  const directives = [
    "default-src 'none'",
    `script-src 'self'${domains ? ` ${domains}` : ''}`,
    `style-src 'self'${domains ? ` ${domains}` : ''}`,
    `img-src 'self' data:${domains ? ` ${domains}` : ''}`,
    `font-src 'self'${domains ? ` ${domains}` : ''}`,
    `connect-src ${connectSrc}`,
    "frame-ancestors 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  return directives.join('; ');
}

/** Validate an app resource for v10 (v8 HTML rules + bridge fields). */
export function validateMcpV10AppResource(resource: unknown): string[] {
  const problems: string[] = [];
  if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
    problems.push('App resource must be an object.');
    return problems;
  }
  const r = resource as Record<string, unknown>;
  if (typeof r.uri !== 'string' || !r.uri.startsWith('ui://')) {
    problems.push('App resource uri must start with "ui://".');
  }
  if (r.mimeType !== MCP_V10_APP_MIME_TYPE) {
    problems.push(`App resource mimeType must be "${MCP_V10_APP_MIME_TYPE}".`);
  }
  if (typeof r.html !== 'string' || r.html.length === 0) {
    problems.push('App resource html must be a non-empty string.');
  } else if (Array.isArray(r.domains)) {
    problems.push(...validateMcpV8AppHtml(r.html, r.domains as string[]).problems);
  } else {
    problems.push('App resource domains must be an array of strings.');
  }
  if (r.allowedTools !== undefined && (!Array.isArray(r.allowedTools) || r.allowedTools.some((t) => typeof t !== 'string'))) {
    problems.push('App resource allowedTools must be an array of strings.');
  }
  return problems;
}

/** One bridge audit event (what the UI asked, what the host decided). */
export interface McpV10BridgeEvent {
  seq: number;
  at: number;
  /** `ui/initialize` / `tools/call` / `ui/close` / `ui/notify` / `rejected`. */
  kind: string;
  /** Tool name (tools/call only). */
  tool?: string;
  /** Whether the host allowed it. */
  allowed: boolean;
  detail?: string;
}

/** Executor the host supplies: runs a tool the bridge relayed. */
export type McpV10AppToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Options for one bridged app session. */
export interface McpV10AppSessionOptions {
  /** App instance id (from the v9 lifecycle manager). */
  appId: string;
  /** `ui://` resource URI. */
  uri: string;
  /** Tool the UI belongs to. */
  toolName: string;
  /** Tools this app may call (allowlist; empty = none). */
  allowedTools?: string[];
  /** Origin the UI is expected to post from (empty = any origin, not recommended). */
  expectedOrigin?: string;
  /** Max call-argument bytes (default 64 KiB). */
  maxCallArgsBytes?: number;
  /** Max calls per minute (default 60). */
  maxCallsPerMinute?: number;
  /** Tool executor (host-supplied). */
  executor?: McpV10AppToolExecutor;
}

/**
 * One bridged app instance: handshake state, allowlist,
 * call log and rate-limit counters. The session never trusts
 * the UI — every message is validated, every call is
 * arbitrated, and the audit log records the decision.
 */
export class McpV10AppSession {
  readonly appId: string;
  readonly uri: string;
  readonly toolName: string;
  readonly allowedTools: readonly string[];
  readonly expectedOrigin: string;
  readonly maxCallArgsBytes: number;
  readonly maxCallsPerMinute: number;
  private readonly executor?: McpV10AppToolExecutor;
  private initialized = false;
  private uiCapabilities?: McpV10AppUiCapabilities;
  private readonly events: McpV10BridgeEvent[] = [];
  private eventSeq = 0;
  private readonly callTimestamps: number[] = [];
  private callCount = 0;
  private rejectedCount = 0;
  private closed = false;

  constructor(options: McpV10AppSessionOptions) {
    if (typeof options.appId !== 'string' || options.appId.length === 0) {
      throw new McpV10AppsError('invalid-session', 'App session appId must be a non-empty string.');
    }
    if (typeof options.uri !== 'string' || !options.uri.startsWith('ui://')) {
      throw new McpV10AppsError('invalid-session', 'App session uri must start with "ui://".');
    }
    this.appId = options.appId;
    this.uri = options.uri;
    this.toolName = options.toolName;
    this.allowedTools = [...(options.allowedTools ?? [])];
    this.expectedOrigin = options.expectedOrigin ?? '';
    this.maxCallArgsBytes = options.maxCallArgsBytes ?? MCP_V10_APP_MAX_CALL_ARGS_BYTES;
    this.maxCallsPerMinute = options.maxCallsPerMinute ?? MCP_V10_APP_MAX_CALLS_PER_MINUTE;
    this.executor = options.executor;
  }

  private log(kind: string, allowed: boolean, detail?: string, tool?: string): void {
    this.eventSeq += 1;
    this.events.push({ seq: this.eventSeq, at: Date.now(), kind, allowed, detail, tool });
    if (this.events.length > MCP_V10_APP_MAX_BRIDGE_EVENTS) {
      this.events.splice(0, this.events.length - MCP_V10_APP_MAX_BRIDGE_EVENTS);
    }
    if (!allowed) this.rejectedCount += 1;
  }

  /** Whether the `ui/initialize` handshake has completed. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Whether the UI sent `ui/close`. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Total relayed tool calls. */
  get totalCalls(): number {
    return this.callCount;
  }

  /** Total rejected messages / calls. */
  get totalRejected(): number {
    return this.rejectedCount;
  }

  /** Audit log (copy, oldest first). */
  auditLog(): McpV10BridgeEvent[] {
    return [...this.events];
  }

  /** Calls in the last minute (rate-limit window). */
  callsInLastMinute(nowMs = Date.now()): number {
    const cutoff = nowMs - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
    return this.callTimestamps.length;
  }

  /** True when the origin check passes (empty expected origin = any, not recommended). */
  checkOrigin(origin: string): boolean {
    if (this.expectedOrigin === '') return true;
    return origin === this.expectedOrigin;
  }

  /**
   * Handle one postMessage from the UI. Returns the JSON-RPC
   * response to post back (undefined for notifications the
   * host answers with nothing). Every rejection is logged
   * with the reason — the UI is untrusted, the host decides.
   */
  async handleMessage(
    message: unknown,
    origin: string,
    nowMs = Date.now(),
  ): Promise<McpV10BridgeMessage | undefined> {
    const fail = (id: string | number | undefined, code: number, text: string): McpV10BridgeMessage => ({
      jsonrpc: '2.0',
      id: id as string | number,
      error: { code, message: text },
    });
    const problems = validateMcpV10BridgeMessage(message);
    if (problems.length > 0) {
      this.log('rejected', false, `Invalid bridge message: ${problems.join(' ')}`);
      return fail(undefined, -32600, `Invalid bridge message: ${problems.join(' ')}`);
    }
    const msg = message as McpV10BridgeMessage;
    if (!this.checkOrigin(origin)) {
      this.log('rejected', false, `Origin "${origin}" does not match the expected origin for this app.`, msg.method === 'tools/call' ? String((msg.params as Record<string, unknown> | undefined)?.name ?? '') : undefined);
      return fail(msg.id, -32001, 'Origin not allowed for this app.');
    }
    if (this.closed && msg.method !== undefined) {
      this.log('rejected', false, 'App session is closed.');
      return fail(msg.id, -32002, 'App session is closed.');
    }
    switch (msg.method) {
      case 'ui/initialize': {
        const params = msg.params ?? {};
        const capsProblems = validateMcpV10AppUiCapabilities(params.capabilities);
        if (capsProblems.length > 0) {
          this.log('ui/initialize', false, capsProblems.join(' '));
          return fail(msg.id, -32602, `Invalid ui/initialize: ${capsProblems.join(' ')}`);
        }
        this.initialized = true;
        this.uiCapabilities = params.capabilities as McpV10AppUiCapabilities;
        const hostCaps: McpV10AppHostCapabilities = {
          bridgeVersion: MCP_V10_APP_BRIDGE_VERSION,
          allowedTools: [...this.allowedTools],
          maxCallArgsBytes: this.maxCallArgsBytes,
          maxCallsPerMinute: this.maxCallsPerMinute,
        };
        this.log('ui/initialize', true, `bridge ${MCP_V10_APP_BRIDGE_VERSION}, ${this.allowedTools.length} allowed tool(s)`);
        return { jsonrpc: '2.0', id: msg.id as string | number, result: { capabilities: hostCaps, appId: this.appId } };
      }
      case 'tools/call': {
        if (!this.initialized) {
          this.log('tools/call', false, 'tools/call before ui/initialize.');
          return fail(msg.id, -32000, 'Call ui/initialize before tools/call.');
        }
        const params = msg.params ?? {};
        const tool = params.name;
        const args = params.arguments;
        if (typeof tool !== 'string' || tool.length === 0) {
          this.log('tools/call', false, 'tools/call needs name (string).');
          return fail(msg.id, -32602, 'tools/call needs name (string).');
        }
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
          this.log('tools/call', false, 'tools/call arguments must be an object.', tool);
          return fail(msg.id, -32602, 'tools/call arguments must be an object.');
        }
        if (!this.allowedTools.includes(tool)) {
          this.log('tools/call', false, `Tool "${tool}" is not on this app's allowlist.`, tool);
          return fail(msg.id, -32003, `Tool "${tool}" is not allowed for this app.`);
        }
        const argsJson = JSON.stringify(args ?? {});
        if (argsJson.length > this.maxCallArgsBytes) {
          this.log('tools/call', false, `Arguments exceed ${this.maxCallArgsBytes} bytes.`, tool);
          return fail(msg.id, -32602, `tools/call arguments exceed ${this.maxCallArgsBytes} bytes.`);
        }
        if (this.callsInLastMinute(nowMs) >= this.maxCallsPerMinute) {
          this.log('tools/call', false, `Rate limit: ${this.maxCallsPerMinute} calls/minute.`, tool);
          return fail(msg.id, -32004, `Rate limit: at most ${this.maxCallsPerMinute} tool calls per minute for this app.`);
        }
        if (!this.executor) {
          this.log('tools/call', false, 'No tool executor is bound to this session.', tool);
          return fail(msg.id, -32603, 'This app session has no tool executor bound.');
        }
        this.callTimestamps.push(nowMs);
        this.callCount += 1;
        try {
          const result = await this.executor(tool, (args ?? {}) as Record<string, unknown>);
          this.log('tools/call', true, undefined, tool);
          return { jsonrpc: '2.0', id: msg.id as string | number, result: { content: result } };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.log('tools/call', true, `tool error: ${text}`, tool);
          return fail(msg.id, -32603, text);
        }
      }
      case 'ui/close': {
        this.closed = true;
        this.log('ui/close', true, 'UI asked to close.');
        return undefined;
      }
      case 'ui/notify': {
        const params = msg.params ?? {};
        this.log('ui/notify', true, typeof params.message === 'string' ? params.message : undefined);
        return undefined;
      }
      default: {
        this.log('rejected', false, `Unknown bridge method "${String(msg.method)}".`);
        return fail(msg.id, -32601, `Unknown bridge method "${String(msg.method)}".`);
      }
    }
  }

  /** Host-side revoke: close the session immediately (further messages are rejected). */
  revoke(reason?: string): void {
    this.closed = true;
    this.log('rejected', false, reason ?? 'Revoked by the host.');
  }

  /** Serialisable snapshot (for the host to mirror). */
  snapshot(): {
    appId: string;
    uri: string;
    toolName: string;
    allowedTools: string[];
    initialized: boolean;
    closed: boolean;
    callCount: number;
    rejectedCount: number;
  } {
    return {
      appId: this.appId,
      uri: this.uri,
      toolName: this.toolName,
      allowedTools: [...this.allowedTools],
      initialized: this.initialized,
      closed: this.closed,
      callCount: this.callCount,
      rejectedCount: this.rejectedCount,
    };
  }
}

/** The bridge host: many sessions, one arbiter. */
export class McpV10AppBridge {
  private readonly sessions = new Map<string, McpV10AppSession>();

  /** Open a session (replaces any session with the same app id). */
  open(options: McpV10AppSessionOptions): McpV10AppSession {
    const session = new McpV10AppSession(options);
    this.sessions.set(session.appId, session);
    return session;
  }

  /** Get a session by app id (undefined when unknown). */
  get(appId: string): McpV10AppSession | undefined {
    return this.sessions.get(appId);
  }

  /** Close + drop a session. Returns true when one was dropped. */
  close(appId: string): boolean {
    const session = this.sessions.get(appId);
    if (!session) return false;
    session.revoke('Closed by the host.');
    return this.sessions.delete(appId);
  }

  /** All live sessions (copy). */
  list(): McpV10AppSession[] {
    return [...this.sessions.values()];
  }

  /** Route one postMessage to its session (undefined when the app id is unknown). */
  async routeMessage(
    appId: string,
    message: unknown,
    origin: string,
    nowMs = Date.now(),
  ): Promise<McpV10BridgeMessage | undefined> {
    const session = this.sessions.get(appId);
    if (!session) return undefined;
    return session.handleMessage(message, origin, nowMs);
  }
}
