/**
 * A2A v1.0 client (v11 generation).
 *
 * The client talks to a peer agent over one of the A2A 1.0 bindings:
 *
 *  - HTTP+JSON: plain `POST` of a JSON-RPC 2.0 envelope to the
 *    peer's card URL (the default; works with any HTTP peer).
 *  - JSON-RPC over a supplied `transport` function (in-process
 *    tests, loopback servers, custom transports).
 *  - SSE streaming: `message/stream` returns server-sent events;
 *    this client parses the `data:` lines into V11TaskEvent objects.
 *
 * Before ANY delegation the client runs the trust sequence:
 * fetch card -> structural validation -> signature verification
 * against pinned keys -> version negotiation. A peer that fails any
 * step is never sent a message (fail-closed). Outbound text is
 * scanned for secret-shaped values before it leaves.
 *
 * No live network is used in tests: pass a `transport` (in-process)
 * or a `fetchImpl` stub. The default `fetchImpl` is the global
 * `fetch` (Node 18+).
 */

import { negotiateV11ProtocolVersion, validateV11AgentCard } from './card';
import { scanV11OutboundText } from './guard';
import { V11AuditLog } from './audit';
import type { V11VerificationKey } from './signing';
import { verifyV11AgentCardAgainstKeys } from './signing';
import {
  V11_METHODS,
  V11_RPC_ERRORS,
  V11A2aError,
  type V11AgentCard,
  type V11JsonRpcRequest,
  type V11JsonRpcResponse,
  type V11ListTasksFilter,
  type V11Message,
  type V11SendResult,
  type V11Task,
  type V11TaskEvent,
  type V11TaskPage,
} from './types';

/** A transport: send one JSON-RPC request, get one response. */
export type V11Transport = (
  request: V11JsonRpcRequest,
) => Promise<V11JsonRpcResponse>;

/** Minimal fetch shape the client needs (global fetch compatible). */
export type V11FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  body?: unknown;
}>;

/** Options for creating a client. */
export interface V11ClientOptions {
  /** Peer card URL (used when no card object is supplied). */
  url?: string;
  /** Known peer card (skips the fetch step). */
  card?: V11AgentCard;
  /** Pinned verification keys for this peer. */
  keys?: V11VerificationKey[];
  /** In-process / custom transport (overrides HTTP). */
  transport?: V11Transport;
  /** Fetch implementation (default: global fetch). */
  fetchImpl?: V11FetchImpl;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Tenant id to send (multi-tenancy header). */
  tenantId?: string;
  /** Audit log to write to. */
  audit?: V11AuditLog;
  /** Skip signature verification (local loopback only). Default false. */
  allowUnsigned?: boolean;
}

/** Result of connecting: card + negotiated version. */
export interface V11ConnectResult {
  card: V11AgentCard;
  version: string;
  signatureVerified: boolean;
}

/** Default request timeout. */
export const V11_CLIENT_TIMEOUT_MS = 30_000;

/** Parse one SSE `data:` line into a task event (null when not data). */
export function parseV11SseLine(line: string): V11TaskEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return null;
  try {
    const parsed = JSON.parse(payload) as V11TaskEvent;
    if (parsed && typeof parsed === 'object' && 'kind' in parsed) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Serialise task events as an SSE body (what a server would send). */
export function v11EventsToSse(events: V11TaskEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

export class V11A2aClient {
  private card?: V11AgentCard;
  private negotiatedVersion?: string;
  private signatureVerified = false;
  private requestCounter = 0;
  private readonly options: V11ClientOptions;
  private readonly audit: V11AuditLog;

  constructor(options: V11ClientOptions = {}) {
    this.options = options;
    this.audit = options.audit ?? new V11AuditLog();
    if (options.card) this.card = options.card;
  }

  get connectedCard(): V11AgentCard | undefined {
    return this.card;
  }

  get version(): string | undefined {
    return this.negotiatedVersion;
  }

  /**
   * Connect: fetch (or take) the card, validate it, verify its
   * signature against pinned keys, negotiate the version. Nothing
   * else may be called before this succeeds.
   */
  async connect(): Promise<V11ConnectResult> {
    const card = await this.loadCard();
    const validation = validateV11AgentCard(card);
    if (!validation.valid) {
      this.audit.append('card.rejected', `Peer card invalid: ${validation.issues.map((i) => i.message).join('; ')}`, {
        data: { issues: validation.issues.map((i) => i.message) },
      });
      throw new V11A2aError(
        `peer card invalid: ${validation.issues.map((i) => i.message).join('; ')}`,
        V11_RPC_ERRORS.cardInvalid,
      );
    }
    const keys = this.options.keys ?? [];
    let verified = false;
    if (card.signature) {
      if (keys.length > 0) {
        const result = verifyV11AgentCardAgainstKeys(card, keys);
        verified = result.valid;
        if (!verified) {
          this.audit.append('card.rejected', `Peer card signature failed: ${result.reason ?? 'invalid'}`, {});
          throw new V11A2aError(
            `peer card signature failed: ${result.reason ?? 'invalid signature'}`,
            V11_RPC_ERRORS.cardInvalid,
          );
        }
      } else if (!this.options.allowUnsigned) {
        throw new V11A2aError(
          'peer card is signed but no verification keys are pinned; pass keys or allowUnsigned for loopback',
          V11_RPC_ERRORS.cardInvalid,
        );
      }
    } else if (!this.options.allowUnsigned) {
      this.audit.append('card.rejected', 'Peer card is unsigned', {});
      throw new V11A2aError(
        'peer card is unsigned — signed cards only (pass allowUnsigned for loopback)',
        V11_RPC_ERRORS.cardInvalid,
      );
    }
    const negotiation = negotiateV11ProtocolVersion(card);
    if (!negotiation.version) {
      throw new V11A2aError(negotiation.reason ?? 'no common protocol version', V11_RPC_ERRORS.invalidParams);
    }
    this.card = card;
    this.negotiatedVersion = negotiation.version;
    this.signatureVerified = verified;
    this.audit.append('card.verified', `Connected to ${card.name} (${negotiation.version}, signature ${verified ? 'verified' : 'not checked'})`, {
      data: { version: negotiation.version, signatureVerified: verified },
    });
    return { card, version: negotiation.version, signatureVerified: verified };
  }

  /** Fetch the peer's card from `/.well-known/agent-card.json`. */
  async fetchCard(): Promise<V11AgentCard> {
    return this.loadCard();
  }

  private async loadCard(): Promise<V11AgentCard> {
    if (this.options.card) return this.options.card;
    const base = this.options.url;
    if (!base) throw new V11A2aError('no card or url supplied to V11A2aClient', V11_RPC_ERRORS.invalidParams);
    const url = `${base.replace(/\/+$/, '')}/.well-known/agent-card.json`;
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as V11FetchImpl | undefined);
    if (!fetchImpl) throw new V11A2aError('no fetch implementation available', V11_RPC_ERRORS.internalError);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? V11_CLIENT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        body: '',
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new V11A2aError(`card fetch failed: HTTP ${res.status} ${res.statusText}`, V11_RPC_ERRORS.cardInvalid);
      }
      return JSON.parse(text) as V11AgentCard;
    } catch (err) {
      if (err instanceof V11A2aError) throw err;
      throw new V11A2aError(`card fetch failed: ${err instanceof Error ? err.message : String(err)}`, V11_RPC_ERRORS.cardInvalid);
    } finally {
      clearTimeout(timer);
    }
  }

  /** SendMessage — requires a prior connect(). */
  async sendMessage(message: V11Message): Promise<V11SendResult> {
    this.requireConnected();
    this.checkOutbound(message);
    const result = await this.call(V11_METHODS.sendMessage, { message });
    return result as V11SendResult;
  }

  /**
   * SendStreamingMessage — returns the collected events plus the
   * final result. Over the HTTP binding the server answers with an
   * SSE body; over a custom transport the server may return
   * `{ events, result }` directly.
   */
  async sendStreamingMessage(
    message: V11Message,
  ): Promise<{ events: V11TaskEvent[]; result: V11SendResult }> {
    this.requireConnected();
    this.checkOutbound(message);
    if (this.options.transport) {
      const result = await this.call(V11_METHODS.sendStreamingMessage, { message });
      const payload = result as { events?: V11TaskEvent[]; result?: V11SendResult };
      if (Array.isArray(payload.events) && payload.result) {
        return { events: payload.events, result: payload.result };
      }
      throw new V11A2aError('streaming response malformed', V11_RPC_ERRORS.internalError);
    }
    const events = await this.postSse(V11_METHODS.sendStreamingMessage, { message });
    const last = events[events.length - 1];
    if (!last || last.kind !== 'status-update' || !last.final) {
      throw new V11A2aError('stream ended without a terminal status update', V11_RPC_ERRORS.internalError);
    }
    // The final result is reconstructed from the terminal event's task id.
    const task = await this.getTask(last.taskId);
    return { events, result: { kind: 'task', task } };
  }

  async getTask(taskId: string): Promise<V11Task> {
    this.requireConnected();
    return (await this.call(V11_METHODS.getTask, { taskId })) as V11Task;
  }

  async listTasks(
    filter: V11ListTasksFilter = {},
    cursor?: string,
    pageSize = 20,
  ): Promise<V11TaskPage> {
    this.requireConnected();
    return (await this.call(V11_METHODS.listTasks, { filter, cursor, pageSize })) as V11TaskPage;
  }

  /** List ALL tasks by walking every cursor page. */
  async listAllTasks(filter: V11ListTasksFilter = {}): Promise<V11Task[]> {
    const all: V11Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.listTasks(filter, cursor, 50);
      all.push(...result.tasks);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return all;
  }

  async cancelTask(taskId: string, reason?: string): Promise<V11Task> {
    this.requireConnected();
    return (await this.call(V11_METHODS.cancelTask, { taskId, ...(reason ? { reason } : {}) })) as V11Task;
  }

  /** GetExtendedAgentCard from the peer. */
  async getExtendedAgentCard(): Promise<unknown> {
    this.requireConnected();
    return this.call(V11_METHODS.getExtendedAgentCard, {});
  }

  /** SubscribeToTask (long-poll over JSON-RPC): returns recent events. */
  async subscribeToTask(taskId: string): Promise<{ taskId: string; events: V11TaskEvent[]; terminal: boolean }> {
    this.requireConnected();
    const result = await this.call(V11_METHODS.subscribeToTask, { taskId });
    return result as { taskId: string; events: V11TaskEvent[]; terminal: boolean };
  }

  /** One JSON-RPC call over the configured transport / HTTP. */
  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requestCounter += 1;
    const request: V11JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.requestCounter,
      method,
      params,
    };
    if (this.options.transport) {
      const response = await this.options.transport(request);
      return this.unwrap(response);
    }
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as V11FetchImpl | undefined);
    if (!fetchImpl) throw new V11A2aError('no fetch implementation available', V11_RPC_ERRORS.internalError);
    const base = this.card?.url ?? this.options.url;
    if (!base) throw new V11A2aError('no peer url (connect first)', V11_RPC_ERRORS.invalidParams);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? V11_CLIENT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(base.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.negotiatedVersion ? { 'A2A-Protocol-Version': this.negotiatedVersion } : {}),
          ...(this.options.tenantId ? { 'A2A-Tenant-Id': this.options.tenantId } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new V11A2aError(`peer HTTP ${res.status}: ${text.slice(0, 200)}`, V11_RPC_ERRORS.internalError);
      }
      return this.unwrap(JSON.parse(text) as V11JsonRpcResponse);
    } catch (err) {
      if (err instanceof V11A2aError) throw err;
      throw new V11A2aError(`peer call failed: ${err instanceof Error ? err.message : String(err)}`, V11_RPC_ERRORS.internalError);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST and parse an SSE body into events. */
  private async postSse(method: string, params: Record<string, unknown>): Promise<V11TaskEvent[]> {
    this.requestCounter += 1;
    const request: V11JsonRpcRequest = { jsonrpc: '2.0', id: this.requestCounter, method, params };
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as V11FetchImpl | undefined);
    if (!fetchImpl) throw new V11A2aError('no fetch implementation available', V11_RPC_ERRORS.internalError);
    const base = this.card?.url ?? this.options.url;
    if (!base) throw new V11A2aError('no peer url (connect first)', V11_RPC_ERRORS.invalidParams);
    const res = await fetchImpl(base.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new V11A2aError(`peer HTTP ${res.status}: ${text.slice(0, 200)}`, V11_RPC_ERRORS.internalError);
    }
    const events: V11TaskEvent[] = [];
    for (const line of text.split('\n')) {
      const event = parseV11SseLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  private unwrap(response: V11JsonRpcResponse): unknown {
    if ('error' in response && response.error) {
      throw new V11A2aError(response.error.message, response.error.code, response.error.data);
    }
    if (!('result' in response)) {
      throw new V11A2aError('malformed JSON-RPC response (no result)', V11_RPC_ERRORS.internalError);
    }
    return (response as { result: unknown }).result;
  }

  /** Outbound secret scan: block the send when a secret would leak. */
  private checkOutbound(message: V11Message): void {
    const text = message.parts
      .filter((p) => p.kind === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    const scan = scanV11OutboundText(text);
    if (scan.blocked) {
      this.audit.append('guard.secret-block', `Outbound message blocked: secret-shaped value (${scan.codes.join(', ')})`, {});
      throw new V11A2aError(
        `outbound message blocked: it contains a secret-shaped value (${scan.codes.join(', ')})`,
        V11_RPC_ERRORS.injectionBlocked,
      );
    }
  }

  private requireConnected(): void {
    if (!this.card || !this.negotiatedVersion) {
      throw new V11A2aError('client is not connected (call connect() first)', V11_RPC_ERRORS.internalError);
    }
  }
}

/**
 * Build a client bound to an in-process server (loopback transport).
 * Used by tests and by local multi-agent setups: no HTTP involved.
 */
export function createV11LoopbackClient(
  handle: (request: V11JsonRpcRequest) => Promise<V11JsonRpcResponse>,
  options: Omit<V11ClientOptions, 'transport'> = {},
): V11A2aClient {
  return new V11A2aClient({ ...options, transport: handle });
}
