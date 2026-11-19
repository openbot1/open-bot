/**
 * Protocols v7 — A2A v1.0.1 client (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: A2A v1.0.1 is the first stable
 * release; the client fetches the Agent Card, verifies its JWS
 * signature, negotiates a version, then drives long-running
 * tasks (message/send, message/stream, tasks/get/cancel/list/
 * resubscribe, push notification configs) across tenants.
 *
 * Transports (the host picks one):
 *   - `A2aV7LoopbackTransport` — in-process, wraps an
 *     `A2aV7Server` directly (tests + hosts that run both ends
 *     locally). No network.
 *   - `A2aV7FetchTransport` — real HTTP via global `fetch`
 *     (JSON-RPC POST + Agent Card GET). The host supplies the
 *     base URL; the client never invents one.
 * The client itself is transport-free: it only speaks JSON-RPC
 * through the transport interface.
 *
 * Safety: the card is verified (JWS + trust store) before any
 * task is sent; a failed verification fails closed; retries
 * only cover transient failures (rate limit / internal error /
 * network error) with bounded backoff; every request carries
 * the tenant header and a per-request timeout.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  A2A_V7_CURRENT_VERSION,
  A2A_V7_TENANT_HEADER,
  A2A_V7_WELL_KNOWN_CARD_JWS_PATH,
  A2A_V7_WELL_KNOWN_CARD_PATH,
  type A2aV7TaskState,
} from './versions';
import {
  A2aV7TrustStore,
  verifyA2aV7AgentCard,
  type A2aV7AgentCard,
  type A2aV7CardVerification,
} from './a2aCardV7';
import {
  type A2aV7JsonRpcRequest,
  type A2aV7JsonRpcResponse,
  type A2aV7StreamEvent,
  type A2aV7Server,
} from './a2aServerV7';
import type { A2aV7Task, A2aV7PushNotificationConfig } from './a2aTaskV7';

/** Error raised by the v7 client layer. */
export class A2aV7ClientError extends Error {
  readonly code: string;
  /** JSON-RPC error code from the server (when the server answered with an error). */
  readonly rpcCode?: number;
  constructor(code: string, message: string, rpcCode?: number) {
    super(message);
    this.name = 'A2aV7ClientError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/** A transport the client speaks JSON-RPC over. */
export interface A2aV7Transport {
  /** Send one JSON-RPC request, get one response. */
  send(request: A2aV7JsonRpcRequest, headers: Record<string, string>): Promise<A2aV7JsonRpcResponse>;
  /** Fetch the Agent Card (JSON) from the peer. */
  fetchCardJson(): Promise<unknown>;
  /** Fetch the signed Agent Card (JWS compact) from the peer. */
  fetchCardJws(): Promise<string>;
}

/**
 * Loopback transport: wraps a server in-process. The card comes
 * from the server's registry; JSON-RPC goes straight to
 * `server.handle`. Used by tests and by hosts running both ends
 * locally.
 */
export class A2aV7LoopbackTransport implements A2aV7Transport {
  private server: A2aV7Server;

  constructor(server: A2aV7Server) {
    this.server = server;
  }

  async send(
    request: A2aV7JsonRpcRequest,
    headers: Record<string, string>,
  ): Promise<A2aV7JsonRpcResponse> {
    return this.server.handle(request, headers);
  }

  async fetchCardJson(): Promise<unknown> {
    const card = this.server.agentCard('default');
    if (!card) throw new A2aV7ClientError('card-not-found', 'Peer serves no Agent Card for the default tenant.');
    return card.json;
  }

  async fetchCardJws(): Promise<string> {
    const card = this.server.agentCard('default');
    if (!card) throw new A2aV7ClientError('card-not-found', 'Peer serves no signed Agent Card for the default tenant.');
    return card.jws;
  }
}

/** Options for the fetch (HTTP) transport. */
export interface A2aV7FetchTransportOptions {
  /** Base URL of the peer agent (e.g. https://agent.example.com). */
  baseUrl: string;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Extra headers sent on every request (never credentials unless the host adds them). */
  extraHeaders?: Record<string, string>;
  /** Tenant header value (default `default`). */
  tenant?: string;
}

/**
 * HTTP transport: JSON-RPC POST to `{baseUrl}/rpc` (the host's
 * convention — the path is fixed here so peers agree) and Agent
 * Card GETs at the well-known paths. Uses global `fetch`.
 */
export class A2aV7FetchTransport implements A2aV7Transport {
  private baseUrl: string;
  private timeoutMs: number;
  private extraHeaders: Record<string, string>;
  private tenant: string;

  constructor(options: A2aV7FetchTransportOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) {
      throw new A2aV7ClientError('invalid-base-url', 'Fetch transport baseUrl must start with http:// or https://.');
    }
    this.baseUrl = base;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = { ...(options.extraHeaders ?? {}) };
    this.tenant = options.tenant ?? 'default';
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async send(
    request: A2aV7JsonRpcRequest,
    headers: Record<string, string>,
  ): Promise<A2aV7JsonRpcResponse> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.extraHeaders,
          ...headers,
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new A2aV7ClientError(
        'transport-error',
        `HTTP transport failed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    if (!response.ok) {
      throw new A2aV7ClientError('http-error', `Peer answered HTTP ${response.status} for JSON-RPC.`);
    }
    try {
      return (await response.json()) as A2aV7JsonRpcResponse;
    } catch {
      throw new A2aV7ClientError('bad-response', 'Peer answered with invalid JSON for JSON-RPC.');
    }
  }

  async fetchCardJson(): Promise<unknown> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${A2A_V7_WELL_KNOWN_CARD_PATH}`, {
      headers: { ...this.extraHeaders, [A2A_V7_TENANT_HEADER]: this.tenant },
    });
    if (!response.ok) {
      throw new A2aV7ClientError('card-not-found', `Peer answered HTTP ${response.status} for the Agent Card.`);
    }
    return response.json() as Promise<unknown>;
  }

  async fetchCardJws(): Promise<string> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${A2A_V7_WELL_KNOWN_CARD_JWS_PATH}`, {
      headers: { ...this.extraHeaders, [A2A_V7_TENANT_HEADER]: this.tenant },
    });
    if (!response.ok) {
      throw new A2aV7ClientError('card-not-found', `Peer answered HTTP ${response.status} for the signed Agent Card.`);
    }
    return (await response.text()).trim();
  }
}

/** Client options. */
export interface A2aV7ClientOptions {
  /** Tenant to act as (default `default`). */
  tenant?: string;
  /** Bearer token sent as Authorization (undefined = no auth). */
  bearerToken?: string;
  /** Trust store for card verification (default: fresh TOFU store). */
  trustStore?: A2aV7TrustStore;
  /** Public key (SPKI PEM) used to verify the peer's card JWS. */
  peerPublicKeyPem?: string;
  /** Max retries for transient failures (default 2). */
  maxRetries?: number;
  /** Base backoff in ms between retries (default 200, doubled each retry). */
  retryBaseMs?: number;
  /** Per-request timeout in ms (loopback transport only; fetch has its own). */
  timeoutMs?: number;
  /** Protocol versions the client requires the card to speak (default: v7 current). */
  requiredProtocolVersions?: readonly string[];
  /** Sleep hook (tests inject a no-op to avoid real waiting). */
  sleep?: (ms: number) => Promise<void>;
}

/** Result of `connect()`: the verified card + negotiated version. */
export interface A2aV7Connection {
  card: A2aV7AgentCard;
  keyId: string;
  negotiatedVersion: string;
  tenant: string;
  trusted: boolean;
  trustReason: string;
}

const TRANSIENT_RPC_CODES = new Set([-32603, -32004]);

/**
 * A2A v1.0.1 client. `connect()` verifies the peer's card
 * before any task is sent; every method after that is a thin
 * typed wrapper over one JSON-RPC call with retries.
 */
export class A2aV7Client {
  private transport: A2aV7Transport;
  private options: A2aV7ClientOptions;
  private tenant: string;
  private requestId = 0;
  private connection: A2aV7Connection | null = null;

  constructor(transport: A2aV7Transport, options: A2aV7ClientOptions = {}) {
    this.transport = transport;
    this.options = { ...options };
    this.tenant = options.tenant ?? 'default';
  }

  /** Tenant this client acts as. */
  getTenant(): string {
    return this.tenant;
  }

  /** The verified connection (null before `connect()`). */
  getConnection(): A2aV7Connection | null {
    return this.connection ? { ...this.connection } : null;
  }

  /** True when `connect()` has succeeded. */
  isConnected(): boolean {
    return this.connection !== null;
  }

  /**
   * Connect: fetch the signed card, verify its JWS, check the
   * trust store, negotiate the version. Fails closed on any
   * problem — no task is ever sent to an unverified peer.
   */
  async connect(): Promise<A2aV7Connection> {
    const jws = await this.transport.fetchCardJws();
    const publicKeyPem = this.options.peerPublicKeyPem;
    if (!publicKeyPem) {
      throw new A2aV7ClientError(
        'no-verification-key',
        'Cannot verify the peer card: no peerPublicKeyPem was given. Pass the peer public key (or a pinned key) explicitly — the client never trusts a card it cannot verify.',
      );
    }
    const verification: A2aV7CardVerification = verifyA2aV7AgentCard(jws, publicKeyPem, {
      allowedTenants: [this.tenant],
      requiredProtocolVersions: this.options.requiredProtocolVersions ?? [A2A_V7_CURRENT_VERSION],
    });
    if (!verification.ok || !verification.card) {
      throw new A2aV7ClientError('card-unverified', `Peer card failed verification: ${verification.reason ?? 'unknown'}.`);
    }
    const trustStore = this.options.trustStore ?? new A2aV7TrustStore('tofu');
    const decision = trustStore.decide(verification.card, verification.keyId ?? '');
    if (!decision.trusted) {
      throw new A2aV7ClientError('card-untrusted', `Peer card verified but not trusted: ${decision.reason}`);
    }
    const negotiated = verification.card.protocolVersions.includes(A2A_V7_CURRENT_VERSION)
      ? A2A_V7_CURRENT_VERSION
      : verification.card.protocolVersions[0];
    this.connection = {
      card: verification.card,
      keyId: verification.keyId ?? '',
      negotiatedVersion: negotiated,
      tenant: this.tenant,
      trusted: true,
      trustReason: decision.reason,
    };
    return { ...this.connection };
  }

  /** Send a message: create + start a task (optionally wait for completion). */
  async sendMessage(
    message: string,
    options: { contextId?: string; timeoutMs?: number; waitForCompletion?: boolean } = {},
  ): Promise<{ task: A2aV7Task; note?: string }> {
    const result = await this.call<{ task: A2aV7Task; note?: string }>('message/send', {
      message,
      contextId: options.contextId,
      timeoutMs: options.timeoutMs,
      waitForCompletion: options.waitForCompletion ?? false,
    });
    return result;
  }

  /** Stream a message: run to completion and get the ordered event frames. */
  async streamMessage(
    message: string,
    options: { contextId?: string; timeoutMs?: number } = {},
  ): Promise<{ taskId: string; events: A2aV7StreamEvent[]; task: A2aV7Task }> {
    return this.call('message/stream', {
      message,
      contextId: options.contextId,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Get a task by id. */
  async getTask(taskId: string): Promise<A2aV7Task> {
    return this.call('tasks/get', { taskId });
  }

  /** Cancel a task. */
  async cancelTask(taskId: string): Promise<A2aV7Task> {
    return this.call('tasks/cancel', { taskId });
  }

  /** List tasks (this tenant only). */
  async listTasks(filter: { status?: A2aV7TaskState; contextId?: string; limit?: number } = {}): Promise<{ tasks: A2aV7Task[]; total: number }> {
    return this.call('tasks/list', { ...filter });
  }

  /** Re-subscribe to a task: replay its status/message events. */
  async resubscribe(taskId: string): Promise<{ taskId: string; events: A2aV7StreamEvent[] }> {
    return this.call('tasks/resubscribe', { taskId });
  }

  /** Set a push notification config for a task. */
  async setPushConfig(
    taskId: string,
    url: string,
    options: { tokenId?: string; states?: A2aV7TaskState[] } = {},
  ): Promise<{ config: A2aV7PushNotificationConfig }> {
    return this.call('tasks/pushNotificationConfig/set', { taskId, url, ...options });
  }

  /** Get one push config. */
  async getPushConfig(taskId: string, configId: string): Promise<{ config: A2aV7PushNotificationConfig }> {
    return this.call('tasks/pushNotificationConfig/get', { taskId, configId });
  }

  /** List a task's push configs. */
  async listPushConfigs(taskId: string): Promise<{ configs: A2aV7PushNotificationConfig[] }> {
    return this.call('tasks/pushNotificationConfig/list', { taskId });
  }

  /** Delete a push config. */
  async deletePushConfig(taskId: string, configId: string): Promise<{ removed: boolean; configId: string }> {
    return this.call('tasks/pushNotificationConfig/delete', { taskId, configId });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { [A2A_V7_TENANT_HEADER]: this.tenant };
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`;
    return headers;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const maxRetries = this.options.maxRetries ?? 2;
    const retryBaseMs = this.options.retryBaseMs ?? 200;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attempt = 0;
    for (;;) {
      const request: A2aV7JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `v7-${++this.requestId}`,
        method,
        params,
      };
      let response: A2aV7JsonRpcResponse;
      try {
        response = await this.transport.send(request, this.headers());
      } catch (err) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw new A2aV7ClientError(
          'transport-error',
          `Call ${method} failed at the transport: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      if ('error' in response) {
        const rpcCode = response.error.code;
        if (TRANSIENT_RPC_CODES.has(rpcCode) && attempt < maxRetries) {
          attempt += 1;
          await sleep(retryBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw new A2aV7ClientError('rpc-error', `Call ${method} failed: ${response.error.message}`, rpcCode);
      }
      return response.result as T;
    }
  }
}

/**
 * Create a loopback client/server pair (one server, one client
 * speaking to it in-process). Returns both ends so tests and
 * hosts can drive the full round-trip without a network.
 */
export function createLoopbackA2aV7Pair(
  server: A2aV7Server,
  clientOptions: A2aV7ClientOptions = {},
): { server: A2aV7Server; client: A2aV7Client; transport: A2aV7LoopbackTransport } {
  const transport = new A2aV7LoopbackTransport(server);
  const client = new A2aV7Client(transport, clientOptions);
  return { server, client, transport };
}

/** Default sleep (real timers). Exported for tests that override it. */
export const defaultA2aV7Sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
