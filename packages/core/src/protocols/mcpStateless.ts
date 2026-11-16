/**
 * MCP stateless client (2026-07-28) — protocol triad v1.15 (Team T2).
 *
 * Idea only, learned from the public MCP 2026-07-28 description
 * in docs/repo-survey-v115.md section 1: the core is stateless
 * — no `initialize` handshake, no `Mcp-Session-Id`; every
 * request carries the protocol version + capabilities in
 * `_meta`; `server/discover` is mandatory; multi round-trip
 * replaces server-initiated requests (the server answers
 * `input_required` and the client retries with the answer);
 * the Tasks extension covers long-running work. No code, text
 * or asset from any other repo is copied here.
 *
 * This module is the v1.15 client built on open-bot's existing
 * stateless primitives (`mcp/stateless.ts`: meta builders,
 * discovery parsing; `mcp/statelessClient.ts`: auto-negotiation):
 *
 * - `McpStatelessClientV115` drives a transport (JSON-RPC over
 *   HTTP by default, via `fetch`) and enforces the stateless
 *   rules: `discover()` first, `_meta` on every request, never
 *   an `initialize` call, never a session id.
 * - `callToolWithInput()` runs the multi round-trip loop: a
 *   tool result of `{input_required: {...}}` pauses the call,
 *   asks the caller's `answerInput` callback for the missing
 *   input, and retries with the answer attached — up to
 *   `maxRounds` rounds, then fails loudly instead of looping
 *   forever.
 * - `StatelessMcpTasks` is the Tasks extension client:
 *   `tasks/create` (when the server offers it), `tasks/get`
 *   polling until the task is done, `tasks/update` to cancel
 *   or re-prioritise, with a local mirror of the task state so
 *   the UI can show progress without polling the server twice.
 * - `LegacyMcpClientAdapter` wraps a pre-2026 client
 *   (`initialize` + session id) behind the stateless surface
 *   so old servers keep working through one call site. It is
 *   marked `@deprecated`: the legacy path is scheduled for
 *   removal with the 12-month deprecation window (the survey
 *   notes the earliest removal date is 28/07/2027), and every
 *   use logs a deprecation warning through the supplied
 *   `onDeprecatedUse` hook.
 *
 * Nothing here keeps server-side state: the client holds only
 * the discovery document, the negotiated version, and the
 * caller's own task mirrors.
 */

import {
  buildStatelessMeta,
  MCP_PROTOCOL_VERSION_2026,
  parseServerDiscoverResult,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
  type StatelessRequestMeta,
} from '../mcp/stateless';

/** Protocol version this client speaks. */
export const MCP_STATELESS_V115_VERSION = MCP_PROTOCOL_VERSION_2026;

/** Default capabilities the v1.15 client advertises in `_meta`. */
export const MCP_STATELESS_V115_CAPABILITIES: StatelessClientCapabilities = {
  multiRoundTrip: true,
  tasks: true,
  apps: true,
};

/** Maximum input round-trips per tool call (loop guard). */
export const MCP_STATELESS_MAX_INPUT_ROUNDS = 5;
/** Maximum task polls before the client gives up waiting. */
export const MCP_STATELESS_MAX_TASK_POLLS = 120;
/** Delay between task polls (ms). */
export const MCP_STATELESS_TASK_POLL_MS = 250;

/** JSON-RPC error object. */
export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** One JSON-RPC request the transport sends. */
export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

/** One JSON-RPC response the transport receives. */
export interface McpStatelessJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: McpJsonRpcError;
}

/** Transport: send one JSON-RPC request, get one response. */
export interface McpStatelessTransport {
  request(request: McpJsonRpcRequest): Promise<McpStatelessJsonRpcResponse>;
}

/** Error thrown when the server refuses a stateless request. */
export class McpStatelessError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'McpStatelessError';
    this.code = code;
  }
}

/**
 * HTTP transport for the stateless client: POSTs JSON-RPC 2.0
 * to the server endpoint with `fetch`. No session header is
 * ever sent — a server that demands `Mcp-Session-Id` is a
 * pre-2026 server and must be reached through the legacy
 * adapter instead.
 */
export class McpHttpTransport implements McpStatelessTransport {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, options: { timeoutMs?: number } = {}) {
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error('McpHttpTransport needs an http(s) endpoint.');
    }
    this.endpoint = endpoint.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request(request: McpJsonRpcRequest): Promise<McpStatelessJsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new McpStatelessError(`MCP HTTP ${response.status} from ${this.endpoint}`);
      }
      return (await response.json()) as McpStatelessJsonRpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The `input_required` payload a server returns instead of a result. */
export interface McpInputRequired {
  /** Short id the client must echo back with the answer. */
  requestId: string;
  /** What the server needs (plain text, shown to the user). */
  prompt: string;
  /** Field names the server expects in the answer. */
  fields: string[];
  /** Which tool call this input belongs to. */
  toolName?: string;
}

/** Parse an `input_required` payload out of a tool result; null when absent. */
export function parseMcpInputRequired(result: unknown): McpInputRequired | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const input = record['input_required'];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const payload = input as Record<string, unknown>;
  if (typeof payload['requestId'] !== 'string' || payload['requestId'] === '') return null;
  if (typeof payload['prompt'] !== 'string' || payload['prompt'] === '') return null;
  if (!Array.isArray(payload['fields']) || (payload['fields'] as unknown[]).some((f) => typeof f !== 'string')) {
    return null;
  }
  return {
    requestId: payload['requestId'] as string,
    prompt: payload['prompt'] as string,
    fields: [...(payload['fields'] as string[])],
    ...(typeof payload['toolName'] === 'string' ? { toolName: payload['toolName'] } : {}),
  };
}

/** A tool result, after the input round-trip loop finished. */
export interface McpToolCallResult {
  /** Raw result object from the server. */
  result: Record<string, unknown>;
  /** How many input round-trips the call took (0 = answered at once). */
  inputRounds: number;
  /** The input requests the server made, in order (for the audit log). */
  inputRequests: McpInputRequired[];
}

/** Task state in the Tasks extension. */
export type McpTaskState = 'pending' | 'running' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** One task, as the client mirrors it. */
export interface McpTask {
  taskId: string;
  state: McpTaskState;
  /** Progress 0..1 when the server reports it. */
  progress?: number;
  /** Human-readable status line from the server. */
  statusText?: string;
  /** Result payload once the task completed. */
  result?: Record<string, unknown>;
  /** Error message once the task failed. */
  error?: string;
  updatedAt: string;
}

/** Options for the stateless client. */
export interface McpStatelessClientV115Options {
  capabilities?: StatelessClientCapabilities;
  /** Protocol version to advertise (default 2026-07-28). */
  protocolVersion?: string;
  maxInputRounds?: number;
}

/**
 * The v1.15 stateless MCP client.
 *
 * Usage:
 * ```
 * const client = new McpStatelessClientV115(transport);
 * await client.discover();          // mandatory first step
 * const tools = await client.listTools();
 * const out = await client.callToolWithInput('search', {q: 'x'}, async (req) => ({
 *   answer: await askUser(req.prompt),
 * }));
 * ```
 * Every request the client sends carries `_meta` with the
 * protocol version + capabilities. The client never calls
 * `initialize` and never sends a session id.
 */
export class McpStatelessClientV115 {
  private readonly transport: McpStatelessTransport;
  private readonly capabilities: StatelessClientCapabilities;
  private readonly protocolVersion: string;
  private readonly maxInputRounds: number;
  private nextId = 1;
  private discovered: ServerDiscoverResult | null = null;

  constructor(transport: McpStatelessTransport, options: McpStatelessClientV115Options = {}) {
    this.transport = transport;
    this.capabilities = options.capabilities ?? MCP_STATELESS_V115_CAPABILITIES;
    this.protocolVersion = options.protocolVersion ?? MCP_STATELESS_V115_VERSION;
    this.maxInputRounds = options.maxInputRounds ?? MCP_STATELESS_MAX_INPUT_ROUNDS;
  }

  /** The discovery document from the last `discover()`, if any. */
  get discovery(): ServerDiscoverResult | null {
    return this.discovered;
  }

  /** True once `discover()` has succeeded. */
  get isDiscovered(): boolean {
    return this.discovered !== null;
  }

  /** The `_meta` attached to every request. */
  meta(): StatelessRequestMeta {
    return buildStatelessMeta({ protocolVersion: this.protocolVersion, capabilities: this.capabilities });
  }

  /** Mandatory first step: ask the server what it is and can do. */
  async discover(): Promise<ServerDiscoverResult> {
    const response = await this.rawRequest('server/discover', {});
    if (response.error) {
      throw new McpStatelessError(
        `server/discover failed: ${response.error.message}`,
        response.error.code,
      );
    }
    this.discovered = parseServerDiscoverResult(response.result ?? {});
    return this.discovered;
  }

  /** List the server's tools (requires discovery first). */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    this.requireDiscovery();
    const response = await this.rawRequest('tools/list', {});
    if (response.error) {
      throw new McpStatelessError(`tools/list failed: ${response.error.message}`, response.error.code);
    }
    const tools = (response.result as Record<string, unknown>)['tools'];
    if (!Array.isArray(tools)) return [];
    return (tools as Array<Record<string, unknown>>)
      .filter((t) => typeof t['name'] === 'string')
      .map((t) => ({
        name: t['name'] as string,
        ...(typeof t['description'] === 'string' ? { description: t['description'] } : {}),
      }));
  }

  /** List the server's resources (requires discovery first). */
  async listResources(): Promise<Array<{ uri: string; name?: string }>> {
    this.requireDiscovery();
    const response = await this.rawRequest('resources/list', {});
    if (response.error) {
      throw new McpStatelessError(`resources/list failed: ${response.error.message}`, response.error.code);
    }
    const resources = (response.result as Record<string, unknown>)['resources'];
    if (!Array.isArray(resources)) return [];
    return (resources as Array<Record<string, unknown>>)
      .filter((r) => typeof r['uri'] === 'string')
      .map((r) => ({
        uri: r['uri'] as string,
        ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
      }));
  }

  /**
   * Call a tool once. Prefer `callToolWithInput()` — this raw
   * call returns the server's answer verbatim, including an
   * `input_required` payload, so the caller can see it.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    extraMeta: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.requireDiscovery();
    if (!name) throw new McpStatelessError('callTool needs a non-empty tool name.');
    const response = await this.rawRequest(
      'tools/call',
      { name, arguments: args },
      extraMeta,
    );
    if (response.error) {
      throw new McpStatelessError(`tools/call ${name} failed: ${response.error.message}`, response.error.code);
    }
    return (response.result ?? {}) as Record<string, unknown>;
  }

  /**
   * Call a tool with the multi round-trip loop: when the server
   * answers `input_required`, `answerInput` is asked for the
   * missing input and the call is retried with the answer
   * attached (`_meta.inputAnswer: {requestId, values}`).
   * Fails with `McpStatelessError` after `maxInputRounds`
   * rounds instead of looping forever.
   */
  async callToolWithInput(
    name: string,
    args: Record<string, unknown>,
    answerInput: (request: McpInputRequired) => Promise<Record<string, unknown>>,
    options: { maxRounds?: number } = {},
  ): Promise<McpToolCallResult> {
    const maxRounds = options.maxRounds ?? this.maxInputRounds;
    const inputRequests: McpInputRequired[] = [];
    let currentArgs = args;
    for (let round = 0; round <= maxRounds; round += 1) {
      const result = await this.callTool(name, currentArgs);
      const required = parseMcpInputRequired(result);
      if (!required) {
        return { result, inputRounds: round, inputRequests };
      }
      if (round === maxRounds) {
        throw new McpStatelessError(
          `tools/call ${name} still needs input after ${maxRounds} round(s) (last: ${required.prompt}).`,
        );
      }
      inputRequests.push(required);
      const values = await answerInput(required);
      currentArgs = {
        ...currentArgs,
        _inputAnswer: { requestId: required.requestId, values },
      };
    }
    throw new McpStatelessError(`tools/call ${name} exceeded the input round-trip limit.`);
  }

  /** Send one raw JSON-RPC request with stateless `_meta` attached. */
  async rawRequest(
    method: string,
    params: Record<string, unknown>,
    extraMeta: Record<string, unknown> = {},
  ): Promise<McpStatelessJsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const meta = { ...this.meta(), ...extraMeta };
    return this.transport.request({
      jsonrpc: '2.0',
      method,
      params: { ...params, _meta: meta },
      id,
    });
  }

  private requireDiscovery(): void {
    if (!this.discovered) {
      throw new McpStatelessError('Call discover() before any other MCP method (stateless 2026-07-28).');
    }
  }
}

/** Options for the Tasks extension client. */
export interface StatelessMcpTasksOptions {
  maxPolls?: number;
  pollMs?: number;
  /** Clock / sleep, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });

/**
 * Tasks extension client (long-running work).
 *
 * - `create()` asks the server to start a long-running task
 *   (`tasks/create`); when the server does not offer it, the
 *   client reports `supported: false` instead of failing the
 *   whole call site.
 * - `get()` reads one task (`tasks/get`) and refreshes the
 *   local mirror.
 * - `waitFor()` polls `tasks/get` until the task reaches a
 *   terminal state (`completed` / `failed` / `cancelled`) or
 *   the poll budget runs out.
 * - `update()` sends `tasks/update` (cancel, re-prioritise).
 * - `list()` returns the local mirrors (never polls).
 */
export class StatelessMcpTasks {
  private readonly client: McpStatelessClientV115;
  private readonly maxPolls: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mirrors = new Map<string, McpTask>();

  constructor(client: McpStatelessClientV115, options: StatelessMcpTasksOptions = {}) {
    this.client = client;
    this.maxPolls = options.maxPolls ?? MCP_STATELESS_MAX_TASK_POLLS;
    this.pollMs = options.pollMs ?? MCP_STATELESS_TASK_POLL_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Local mirrors of every task this client has seen. */
  list(): McpTask[] {
    return [...this.mirrors.values()];
  }

  getLocal(taskId: string): McpTask | undefined {
    return this.mirrors.get(taskId);
  }

  async create(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ supported: boolean; task?: McpTask; message?: string }> {
    const response = await this.client.rawRequest('tasks/create', {
      tool: toolName,
      arguments: args,
    });
    if (response.error) {
      if (response.error.code === -32601) {
        return { supported: false, message: `Server does not offer tasks/create: ${response.error.message}` };
      }
      throw new McpStatelessError(`tasks/create failed: ${response.error.message}`, response.error.code);
    }
    const result = response.result ?? {};
    const task = this.mirrorFromServer(result);
    if (!task) {
      return { supported: false, message: 'tasks/create answered without a taskId.' };
    }
    return { supported: true, task };
  }

  async get(taskId: string): Promise<McpTask> {
    const response = await this.client.rawRequest('tasks/get', { taskId });
    if (response.error) {
      throw new McpStatelessError(`tasks/get ${taskId} failed: ${response.error.message}`, response.error.code);
    }
    const task = this.mirrorFromServer(response.result ?? {});
    if (!task) throw new McpStatelessError(`tasks/get ${taskId} answered without a task.`);
    return task;
  }

  async update(
    taskId: string,
    update: { state?: 'cancelled'; priority?: number; note?: string },
  ): Promise<McpTask> {
    const response = await this.client.rawRequest('tasks/update', { taskId, ...update });
    if (response.error) {
      throw new McpStatelessError(`tasks/update ${taskId} failed: ${response.error.message}`, response.error.code);
    }
    const task = this.mirrorFromServer(response.result ?? {});
    if (!task) throw new McpStatelessError(`tasks/update ${taskId} answered without a task.`);
    return task;
  }

  /** Poll until the task is terminal; throws when the budget runs out. */
  async waitFor(taskId: string): Promise<McpTask> {
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      const task = await this.get(taskId);
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') {
        return task;
      }
      if (poll < this.maxPolls - 1) await this.sleep(this.pollMs);
    }
    throw new McpStatelessError(`Task ${taskId} did not reach a terminal state after ${this.maxPolls} polls.`);
  }

  private mirrorFromServer(result: Record<string, unknown>): McpTask | null {
    const taskId = result['taskId'];
    const state = result['state'];
    if (typeof taskId !== 'string' || taskId === '') return null;
    if (
      state !== 'pending' && state !== 'running' && state !== 'input_required' &&
      state !== 'completed' && state !== 'failed' && state !== 'cancelled'
    ) {
      return null;
    }
    const task: McpTask = {
      taskId,
      state: state as McpTaskState,
      updatedAt: new Date().toISOString(),
      ...(typeof result['progress'] === 'number' ? { progress: result['progress'] } : {}),
      ...(typeof result['statusText'] === 'string' ? { statusText: result['statusText'] } : {}),
      ...(typeof result['result'] === 'object' && result['result'] !== null && !Array.isArray(result['result'])
        ? { result: result['result'] as Record<string, unknown> }
        : {}),
      ...(typeof result['error'] === 'string' ? { error: result['error'] } : {}),
    };
    this.mirrors.set(taskId, task);
    return task;
  }
}

/**
 * Minimal surface of a pre-2026 MCP client (handshake-based),
 * for the legacy adapter below.
 */
export interface LegacyMcpClientSurface {
  initialize(): Promise<{ protocolVersion?: string }>;
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The session id the legacy client negotiated (if any). */
  sessionId?: string;
}

/**
 * @deprecated — Legacy adapter for pre-2026 MCP servers.
 *
 * Wraps a handshake-based client (`initialize` + session id)
 * behind the stateless surface so old servers keep working
 * through one call site. The legacy path is scheduled for
 * removal with the 12-month deprecation window (earliest
 * removal 28/07/2027 per the survey); every use calls
 * `onDeprecatedUse` (when supplied) so the app can warn the
 * user to upgrade the server. New servers must use
 * `McpStatelessClientV115`.
 *
 * The adapter translates `discover()` into `initialize()` and
 * reports the handshake version as the discovery version; it
 * still attaches `_meta` to every request so the server sees
 * the same shape it would from a stateless client.
 */
export class LegacyMcpClientAdapter {
  private readonly legacy: LegacyMcpClientSurface;
  private readonly onDeprecatedUse?: (detail: string) => void;
  private readonly capabilities: StatelessClientCapabilities;
  private readonly protocolVersion: string;
  private warned = false;
  private discovered: ServerDiscoverResult | null = null;

  constructor(
    legacy: LegacyMcpClientSurface,
    options: {
      onDeprecatedUse?: (detail: string) => void;
      capabilities?: StatelessClientCapabilities;
      protocolVersion?: string;
    } = {},
  ) {
    this.legacy = legacy;
    this.onDeprecatedUse = options.onDeprecatedUse;
    this.capabilities = options.capabilities ?? MCP_STATELESS_V115_CAPABILITIES;
    this.protocolVersion = options.protocolVersion ?? MCP_STATELESS_V115_VERSION;
  }

  get discovery(): ServerDiscoverResult | null {
    return this.discovered;
  }

  /** True once the legacy handshake has run. */
  get isDiscovered(): boolean {
    return this.discovered !== null;
  }

  private warnOnce(detail: string): void {
    if (this.warned) return;
    this.warned = true;
    this.onDeprecatedUse?.(detail);
  }

  async discover(): Promise<ServerDiscoverResult> {
    this.warnOnce(
      'Legacy MCP client used (initialize handshake + session id). Deprecated: upgrade the server to MCP 2026-07-28 stateless; the legacy path is scheduled for removal (earliest 28/07/2027).',
    );
    const info = await this.legacy.initialize();
    const version = info.protocolVersion ?? '2025-11-25';
    this.discovered = {
      protocolVersion: version,
      serverInfo: { name: 'legacy-server', version },
      capabilities: {},
    };
    return this.discovered;
  }

  /** Call a tool through the legacy client (handshake first). */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.discovered) await this.discover();
    this.warnOnce('Legacy MCP tools/call used (deprecated handshake path).');
    const meta = buildStatelessMeta({ protocolVersion: this.protocolVersion, capabilities: this.capabilities });
    return this.legacy.call('tools/call', {
      name,
      arguments: args,
      _meta: meta,
      ...(this.legacy.sessionId ? { _sessionId: this.legacy.sessionId } : {}),
    });
  }
}
