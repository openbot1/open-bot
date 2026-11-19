/**
 * Protocols v7 — A2A v1.0.1 server (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: A2A v1.0.1 is the first stable
 * release, with multi-protocol and multi-tenancy. This module is
 * the complete v7 server side: a transport-free JSON-RPC 2.0
 * dispatcher over the v7 task store / engine and card registry.
 * The host binds its own HTTP transport (or the loopback pair in
 * `a2aClientV7.ts`); this module never opens a socket.
 *
 * Methods (see `A2A_V7_METHODS` in versions.ts):
 *   message/send, message/stream, tasks/get, tasks/cancel,
 *   tasks/list, tasks/resubscribe,
 *   tasks/pushNotificationConfig/set|get|list|delete.
 * Plus card serving: `agentCard` (JSON + signed JWS) per tenant.
 *
 * Safety: per-tenant bearer tokens (the host supplies them; the
 * tokens themselves are never stored here beyond the map the host
 * passes in), unknown tenants are refused, a simple per-tenant
 * rate limit, and every error is a typed JSON-RPC error — no
 * stack traces leak to the peer. A task in another tenant is
 * invisible (404), never "forbidden" — tenants must not learn
 * each other's task ids.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  A2A_V7_AGENT_CARD_MEDIA_TYPE,
  A2A_V7_METHODS,
  A2A_V7_TENANT_HEADER,
  type A2aV7Method,
  type A2aV7TaskState,
} from './versions';
import { A2aV7CardRegistry, normalizeA2aV7TenantId } from './a2aCardV7';
import {
  A2aV7TaskEngine,
  A2aV7TaskStore,
  buildA2aV7Message,
  a2aV7TextPart,
  type A2aV7Message,
  type A2aV7Task,
} from './a2aTaskV7';

/** Error raised by the v7 server layer (before JSON-RPC encoding). */
export class A2aV7ServerError extends Error {
  readonly code: string;
  /** JSON-RPC error code (e.g. -32601). */
  readonly rpcCode: number;
  constructor(code: string, rpcCode: number, message: string) {
    super(message);
    this.name = 'A2aV7ServerError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** JSON-RPC 2.0 request. */
export interface A2aV7JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response (result or error, never both). */
export type A2aV7JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

/** One event in a message/stream or resubscribe replay. */
export interface A2aV7StreamEvent {
  /** Event kind. */
  kind: 'status' | 'message' | 'artifact' | 'done';
  /** Task state at this event (status / done events). */
  state?: A2aV7TaskState;
  /** Message (message events). */
  message?: A2aV7Message;
  /** Artifact id (artifact events). */
  artifactId?: string;
  /** Event time (ms since epoch). */
  atMs: number;
  /** Free-text note (e.g. the transition reason). */
  note?: string;
}

/** Server options (all host-supplied). */
export interface A2aV7ServerOptions {
  /** Task store (required). */
  store: A2aV7TaskStore;
  /** Task engine (required for message/send to run work; without it tasks stay submitted). */
  engine?: A2aV7TaskEngine;
  /** Card registry (required for agentCard serving). */
  cardRegistry?: A2aV7CardRegistry;
  /** Per-tenant bearer tokens: tenant -> token. Empty = no auth (loopback / local use). */
  tenantTokens?: Record<string, string>;
  /** Max requests per tenant per minute (default 600). */
  rateLimitPerMinute?: number;
  /** Default tenant when the header is absent (default `default`). */
  defaultTenant?: string;
  /** Clock override (ms since epoch; default Date.now). */
  nowMs?: () => number;
}

/** Rate-limit window entry (per tenant). */
interface A2aV7RateWindow {
  windowStartMs: number;
  count: number;
}

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_UNAUTHORIZED = -32001;
const RPC_NOT_FOUND = -32002;
const RPC_RATE_LIMITED = -32004;
const RPC_TASK_ERROR = -32000;

/** JSON-RPC error codes used by the v7 server. */
export const A2A_V7_RPC_ERROR_CODES = {
  parseError: RPC_PARSE_ERROR,
  invalidRequest: RPC_INVALID_REQUEST,
  methodNotFound: RPC_METHOD_NOT_FOUND,
  invalidParams: RPC_INVALID_PARAMS,
  internalError: RPC_INTERNAL_ERROR,
  unauthorized: RPC_UNAUTHORIZED,
  notFound: RPC_NOT_FOUND,
  rateLimited: RPC_RATE_LIMITED,
  taskError: RPC_TASK_ERROR,
} as const;

/**
 * A2A v1.0.1 server: dispatches JSON-RPC requests for one
 * tenant at a time. Stateless per request except the shared
 * store / engine / registry the host passes in.
 */
export class A2aV7Server {
  private store: A2aV7TaskStore;
  private engine?: A2aV7TaskEngine;
  private cardRegistry?: A2aV7CardRegistry;
  private tenantTokens: Map<string, string>;
  private rateLimitPerMinute: number;
  private defaultTenant: string;
  private nowMs: () => number;
  private rateWindows = new Map<string, A2aV7RateWindow>();

  constructor(options: A2aV7ServerOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.cardRegistry = options.cardRegistry;
    this.tenantTokens = new Map(Object.entries(options.tenantTokens ?? {}));
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? 600;
    this.defaultTenant = options.defaultTenant ?? 'default';
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Agent Card media type served at /.well-known/agent-card.json. */
  get cardMediaType(): string {
    return A2A_V7_AGENT_CARD_MEDIA_TYPE;
  }

  /** Resolve the tenant from request headers (falls back to default). */
  resolveTenant(headers: Record<string, string | undefined>): string {
    const raw = headers[A2A_V7_TENANT_HEADER]
      ?? headers[A2A_V7_TENANT_HEADER.toLowerCase()];
    return normalizeA2aV7TenantId(raw ?? this.defaultTenant, this.defaultTenant);
  }

  /** Check a bearer token for a tenant (true when auth is off or the token matches). */
  checkAuth(tenant: string, authorization: string | undefined): boolean {
    const expected = this.tenantTokens.get(tenant);
    if (expected === undefined) return true;
    if (typeof authorization !== 'string') return false;
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
    return token.length > 0 && token === expected;
  }

  /** Serve the Agent Card (JSON + signed JWS) for a tenant. */
  agentCard(tenant: string): { json: unknown; jws: string; mediaType: string } | null {
    const registry = this.cardRegistry;
    if (!registry) return null;
    const cards = registry.list(tenant, this.nowMs());
    if (cards.length === 0) return null;
    const first = cards[0];
    return { json: first.card, jws: first.jws, mediaType: A2A_V7_AGENT_CARD_MEDIA_TYPE };
  }

  /**
   * Handle one JSON-RPC request. `headers` carry the tenant
   * header and the Authorization header. Returns a response
   * object (never throws for a bad request — errors are encoded).
   */
  async handle(
    request: unknown,
    headers: Record<string, string | undefined> = {},
  ): Promise<A2aV7JsonRpcResponse> {
    const req = request as Partial<A2aV7JsonRpcRequest> | null;
    const id = (req && typeof req === 'object' && 'id' in req ? req.id : null) ?? null;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0'
      || typeof req.method !== 'string' || req.method.length === 0) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_INVALID_REQUEST, message: 'Request must be a JSON-RPC 2.0 object with a method.' },
      };
    }
    const tenant = this.resolveTenant(headers);
    if (!this.checkAuth(tenant, headers.authorization ?? headers.Authorization)) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_UNAUTHORIZED, message: `Unauthorized for tenant "${tenant}".` },
      };
    }
    if (!this.checkRateLimit(tenant)) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_RATE_LIMITED, message: `Rate limited for tenant "${tenant}" (max ${this.rateLimitPerMinute}/minute).` },
      };
    }
    try {
      const result = await this.dispatch(req.method, (req.params ?? {}) as Record<string, unknown>, tenant);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof A2aV7ServerError) {
        return { jsonrpc: '2.0', id, error: { code: err.rpcCode, message: err.message, data: { code: err.code } } };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_INTERNAL_ERROR, message: 'Internal server error.' },
      };
    }
  }

  /** Handle a batch of requests (each answered independently). */
  async handleBatch(
    requests: unknown[],
    headers: Record<string, string | undefined> = {},
  ): Promise<A2aV7JsonRpcResponse[]> {
    const out: A2aV7JsonRpcResponse[] = [];
    for (const req of requests) out.push(await this.handle(req, headers));
    return out;
  }

  /** Current rate-limit usage per tenant (for the UI). */
  rateUsage(): { tenant: string; count: number; limit: number }[] {
    const now = this.nowMs();
    const out: { tenant: string; count: number; limit: number }[] = [];
    for (const [tenant, window] of this.rateWindows) {
      if (now - window.windowStartMs >= 60_000) continue;
      out.push({ tenant, count: window.count, limit: this.rateLimitPerMinute });
    }
    return out;
  }

  private checkRateLimit(tenant: string): boolean {
    const now = this.nowMs();
    const window = this.rateWindows.get(tenant);
    if (!window || now - window.windowStartMs >= 60_000) {
      this.rateWindows.set(tenant, { windowStartMs: now, count: 1 });
      return true;
    }
    if (window.count >= this.rateLimitPerMinute) return false;
    window.count += 1;
    return true;
  }

  private dispatch(
    method: string,
    params: Record<string, unknown>,
    tenant: string,
  ): Promise<unknown> {
    switch (method as A2aV7Method) {
      case 'message/send':
        return this.messageSend(params, tenant);
      case 'message/stream':
        return this.messageStream(params, tenant);
      case 'tasks/get':
        return Promise.resolve(this.taskInTenant(params, tenant));
      case 'tasks/cancel':
        return Promise.resolve(this.taskCancel(params, tenant));
      case 'tasks/list':
        return Promise.resolve(this.taskList(params, tenant));
      case 'tasks/resubscribe':
        return Promise.resolve(this.taskResubscribe(params, tenant));
      case 'tasks/pushNotificationConfig/set':
        return Promise.resolve(this.pushSet(params, tenant));
      case 'tasks/pushNotificationConfig/get':
        return Promise.resolve(this.pushGet(params, tenant));
      case 'tasks/pushNotificationConfig/list':
        return Promise.resolve(this.pushList(params, tenant));
      case 'tasks/pushNotificationConfig/delete':
        return Promise.resolve(this.pushDelete(params, tenant));
      default:
        throw new A2aV7ServerError('method-not-found', RPC_METHOD_NOT_FOUND, `Method "${method}" is not part of A2A v1.0.1 (known: ${A2A_V7_METHODS.join(', ')}).`);
    }
  }

  private requireString(params: Record<string, unknown>, name: string): string {
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new A2aV7ServerError('invalid-params', RPC_INVALID_PARAMS, `Param "${name}" must be a non-empty string.`);
    }
    return value;
  }

  private optionalString(params: Record<string, unknown>, name: string): string | undefined {
    const value = params[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new A2aV7ServerError('invalid-params', RPC_INVALID_PARAMS, `Param "${name}" must be a string.`);
    }
    return value;
  }

  /** Fetch a task and prove it belongs to this tenant (404 otherwise). */
  private taskInTenant(params: Record<string, unknown>, tenant: string): A2aV7Task {
    const taskId = this.requireString(params, 'taskId');
    const task = this.store.get(taskId);
    if (!task || task.tenant !== tenant) {
      throw new A2aV7ServerError('task-not-found', RPC_NOT_FOUND, `Task ${taskId} does not exist in tenant "${tenant}".`);
    }
    return task;
  }

  private async messageSend(params: Record<string, unknown>, tenant: string): Promise<unknown> {
    const message = this.requireString(params, 'message');
    const contextId = this.optionalString(params, 'contextId');
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined;
    const waitForCompletion = params.waitForCompletion === true;
    const task = this.store.create({ tenant, message, contextId, timeoutMs });
    if (!this.engine) return { task, note: 'No engine bound: task stays submitted.' };
    const running = this.engine.start(task.id);
    if (!waitForCompletion) {
      return { task: this.store.get(task.id), note: 'Task started asynchronously; poll tasks/get or resubscribe.' };
    }
    const finished = await running.done;
    return { task: finished, note: 'Task finished (waitForCompletion).' };
  }

  /**
   * message/stream: run the task to completion and return the
   * ordered event frames (status changes, messages, artifacts,
   * done). A real SSE transport replays these frames as they
   * arrive; the collected form is what the loopback pair and
   * tests use.
   */
  private async messageStream(params: Record<string, unknown>, tenant: string): Promise<unknown> {
    const message = this.requireString(params, 'message');
    const contextId = this.optionalString(params, 'contextId');
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined;
    const task = this.store.create({ tenant, message, contextId, timeoutMs });
    const events: A2aV7StreamEvent[] = [
      { kind: 'status', state: 'submitted', atMs: task.createdAtMs, note: 'created' },
    ];
    if (!this.engine) {
      events.push({ kind: 'done', state: 'submitted', atMs: Date.now(), note: 'No engine bound: task stays submitted.' });
      return { taskId: task.id, events };
    }
    const running = this.engine.start(task.id);
    const finished = await running.done;
    for (const change of finished.statusHistory.slice(1)) {
      events.push({ kind: 'status', state: change.state, atMs: change.atMs, note: change.reason });
    }
    for (const msg of finished.history.slice(1)) {
      events.push({ kind: 'message', message: msg, atMs: msg.createdAtMs });
    }
    for (const artifact of finished.artifacts) {
      events.push({ kind: 'artifact', artifactId: artifact.artifactId, atMs: artifact.createdAtMs, note: artifact.name });
    }
    events.push({ kind: 'done', state: finished.status, atMs: finished.updatedAtMs });
    return { taskId: task.id, events, task: finished };
  }

  private taskCancel(params: Record<string, unknown>, tenant: string): A2aV7Task {
    const task = this.taskInTenant(params, tenant);
    if (!this.engine) {
      return this.store.transition(task.id, 'canceled', 'canceled by client (no engine bound)');
    }
    return this.engine.cancel(task.id, 'canceled by client');
  }

  private taskList(params: Record<string, unknown>, tenant: string): { tasks: A2aV7Task[]; total: number } {
    const status = typeof params.status === 'string' ? params.status as A2aV7TaskState : undefined;
    const contextId = this.optionalString(params, 'contextId');
    const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 50;
    const tasks = this.store.list({ tenant, status, contextId, limit });
    return { tasks, total: tasks.length };
  }

  private taskResubscribe(params: Record<string, unknown>, tenant: string): { taskId: string; events: A2aV7StreamEvent[] } {
    const task = this.taskInTenant(params, tenant);
    const events: A2aV7StreamEvent[] = task.statusHistory.map((change) => ({
      kind: 'status' as const,
      state: change.state,
      atMs: change.atMs,
      note: change.reason,
    }));
    for (const msg of task.history) {
      events.push({ kind: 'message', message: msg, atMs: msg.createdAtMs });
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return { taskId: task.id, events };
  }

  private pushSet(params: Record<string, unknown>, tenant: string): unknown {
    const task = this.taskInTenant(params, tenant);
    const url = this.requireString(params, 'url');
    const states = Array.isArray(params.states)
      ? (params.states as string[]).filter((s): s is A2aV7TaskState =>
        ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'rejected'].includes(s))
      : undefined;
    const config = this.store.addPushConfig(task.id, url, {
      tokenId: this.optionalString(params, 'tokenId'),
      states,
    });
    return { config };
  }

  private pushGet(params: Record<string, unknown>, tenant: string): unknown {
    const task = this.taskInTenant(params, tenant);
    const configId = this.requireString(params, 'configId');
    const config = this.store.listPushConfigs(task.id).find((c) => c.id === configId);
    if (!config) {
      throw new A2aV7ServerError('push-config-not-found', RPC_NOT_FOUND, `Push config ${configId} does not exist on task ${task.id}.`);
    }
    return { config };
  }

  private pushList(params: Record<string, unknown>, tenant: string): unknown {
    const task = this.taskInTenant(params, tenant);
    return { configs: this.store.listPushConfigs(task.id) };
  }

  private pushDelete(params: Record<string, unknown>, tenant: string): unknown {
    const task = this.taskInTenant(params, tenant);
    const configId = this.requireString(params, 'configId');
    const removed = this.store.removePushConfig(task.id, configId);
    if (!removed) {
      throw new A2aV7ServerError('push-config-not-found', RPC_NOT_FOUND, `Push config ${configId} does not exist on task ${task.id}.`);
    }
    return { removed: true, configId };
  }
}

/** Build a user message object for message/send params (helper for hosts). */
export function a2aV7ServerUserMessage(
  text: string,
  taskId: string,
  contextId: string,
): A2aV7Message {
  return buildA2aV7Message('user', [a2aV7TextPart(text)], taskId, contextId);
}

/** The methods this server answers (for capability advertisement). */
export function a2aV7ServerMethods(): readonly A2aV7Method[] {
  return A2A_V7_METHODS;
}
