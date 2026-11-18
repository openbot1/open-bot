/**
 * Protocols v3 — Streamable HTTP transport v3 (v1.19, Team T3).
 *
 * Idea only, learned from the public MCP spec 2026-07-28 description
 * in docs/repo-survey-v119.md section 2: the transport is Streamable
 * HTTP (one POST endpoint; the server may answer with a single JSON
 * response or an SSE stream, and the client may open a GET SSE
 * stream for server-initiated messages), replacing the old HTTP+SSE
 * transport. No code, text or asset from any other repo is copied here.
 *
 * This builds on the existing transport without touching it:
 *  - `mcp/transport.ts` — the 2025-11-25 Streamable HTTP transport
 *    (POST + SSE response, GET SSE stream, `Last-Event-ID` resume,
 *    DELETE session close);
 *  - `mcp/statelessTransport.ts` — the stateless probe transport.
 * v3 replaces the session parts and finishes the migration:
 *   1. no session id anywhere — requests carry no `Mcp-Session-Id`
 *      header and the transport refuses to send one; DELETE is gone
 *      (there is nothing to close);
 *   2. per-request protocol version — every POST carries the
 *      `MCP-Protocol-Version` header (see `mcpStatelessV3.ts`);
 *   3. response modes — single JSON response, SSE stream of
 *      JSON-RPC messages, and a GET stream for server-initiated
 *      messages, all parsed by one SSE parser with resume via
 *      `Last-Event-ID`;
 *   4. legacy compat flag — `legacyHttpSse: true` keeps the old
 *      HTTP+SSE behaviour (session header + DELETE) for pre-2.0
 *      servers; the default is off and the flag is logged when used;
 *   5. resumability store — an in-memory store of received event
 *      ids per URL so a dropped GET stream resumes exactly where it
 *      left off instead of replaying the whole stream.
 *
 * The transport is a plain function surface (`TransportFetchFn`,
 * injected) so tests use a fake fetch and no real network is ever
 * touched. Nothing here logs request bodies or auth headers.
 */

import { MCP_PROTOCOL_VERSION_2026 } from '../mcp/stateless';
import {
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
  buildStatelessRequestHeaders,
} from './mcpStatelessV3';

/** Transport version this module implements. */
export const STREAMABLE_HTTP_V3_VERSION = MCP_PROTOCOL_VERSION_2026;
/** Default per-request timeout. */
export const STREAMABLE_HTTP_V3_TIMEOUT_MS = 30_000;
/** Default GET-stream reconnect attempts. */
export const STREAMABLE_HTTP_V3_RECONNECT_ATTEMPTS = 3;
/** Delay between reconnect attempts. */
export const STREAMABLE_HTTP_V3_RECONNECT_DELAY_MS = 1_000;
/** Max SSE events buffered per stream before the oldest are dropped. */
export const STREAMABLE_HTTP_V3_MAX_BUFFERED_EVENTS = 500;
/** Max bytes of one SSE event payload (protects against a runaway server). */
export const STREAMABLE_HTTP_V3_MAX_EVENT_BYTES = 4 * 1024 * 1024;

/** Error raised by the v3 Streamable HTTP transport. */
export class StreamableHttpV3Error extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'StreamableHttpV3Error';
    this.code = code;
    this.status = status;
  }
}

/** Injectable fetch (same shape as the global `fetch`). */
export type V3TransportFetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** How the server answered a POST. */
export type V3PostResponseMode = 'json' | 'sse' | 'accepted';

/** One parsed SSE event. */
export interface V3SseEvent {
  /** Event id (`id:` field), for resume. */
  id?: string;
  /** Event type (`event:` field). */
  event?: string;
  /** Raw data payload (joined `data:` lines). */
  data: string;
}

/**
 * Parse one SSE text chunk into events. Handles `id:`, `event:`,
 * `data:` (multi-line joined with `\n`), `:` comments, and `\r\n`
 * line endings. Incomplete trailing data is returned as `leftover`
 * so the caller can prepend it to the next chunk. Events larger
 * than `maxEventBytes` are dropped with `dropped` counted.
 */
export function parseV3SseChunk(
  chunk: string,
  options: { maxEventBytes?: number } = {},
): { events: V3SseEvent[]; leftover: string; dropped: number } {
  const maxBytes = options.maxEventBytes ?? STREAMABLE_HTTP_V3_MAX_EVENT_BYTES;
  const text = chunk;
  const events: V3SseEvent[] = [];
  let dropped = 0;
  // Split on blank lines; the last segment may be incomplete.
  const segments = text.split(/\r?\n\r?\n/);
  const leftover = segments.pop() ?? '';
  for (const segment of segments) {
    if (segment.trim() === '') continue;
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of segment.split(/\r?\n/)) {
      if (line.startsWith(':')) continue; // comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      // Unknown fields are ignored (forward compatibility).
    }
    if (dataLines.length === 0 && id === undefined && event === undefined) continue;
    const data = dataLines.join('\n');
    if (data.length > maxBytes) {
      dropped += 1;
      continue;
    }
    events.push({ id, event, data });
  }
  return { events, leftover, dropped };
}

/** Parse the `data:` payload of one SSE event as JSON-RPC, or null. */
export function parseV3SseJsonRpc(event: V3SseEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** In-memory resume store: last seen event id per stream URL. */
export class V3ResumeStore {
  private readonly lastIds = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  /** Record an event id for a URL. */
  record(url: string, eventId: string | undefined): void {
    if (eventId !== undefined && eventId !== '') this.lastIds.set(url, eventId);
    this.counts.set(url, (this.counts.get(url) ?? 0) + 1);
  }

  /** Last seen event id for a URL, or undefined. */
  lastEventId(url: string): string | undefined {
    return this.lastIds.get(url);
  }

  /** Number of events recorded for a URL. */
  eventCount(url: string): number {
    return this.counts.get(url) ?? 0;
  }

  /** Forget a URL (fresh stream). */
  forget(url: string): void {
    this.lastIds.delete(url);
    this.counts.delete(url);
  }

  /** All tracked URLs. */
  urls(): string[] {
    return [...this.lastIds.keys()];
  }
}

/** Options for the v3 Streamable HTTP transport. */
export interface StreamableHttpV3Options {
  /** Injected fetch (required — no network without it). */
  fetchFn: V3TransportFetchFn;
  /** Protocol version sent on every request. */
  protocolVersion?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /**
   * Legacy compat: keep the old HTTP+SSE behaviour (session header
   * + DELETE close) for pre-2.0 servers. Default false. When true
   * the transport records a `legacyUsed` flag the caller can log.
   */
  legacyHttpSse?: boolean;
  /** Session id to send when legacy mode is on (never sent otherwise). */
  legacySessionId?: string;
  /** Extra headers sent on every request (never credentials in logs). */
  extraHeaders?: Record<string, string>;
  /** Resume store (a fresh one is created when omitted). */
  resumeStore?: V3ResumeStore;
  /** Reconnect attempts for the GET stream. */
  reconnectAttempts?: number;
  /** Delay between GET-stream reconnects. */
  reconnectDelayMs?: number;
}

/** One JSON-RPC message received over the transport. */
export interface V3TransportMessage {
  /** Raw JSON-RPC object. */
  message: Record<string, unknown>;
  /** SSE event id it arrived with (for resume). */
  eventId?: string;
  /** SSE event type, when the server set one. */
  eventType?: string;
}

/** Result of one POST request. */
export interface V3PostResult {
  /** How the server answered. */
  mode: V3PostResponseMode;
  /** Messages received (1 for `json`, 0..n for `sse`, 0 for `accepted`). */
  messages: V3TransportMessage[];
  /** HTTP status. */
  status: number;
  /** Protocol version the server answered with (header), if any. */
  serverProtocolVersion: string | null;
  /** SSE events dropped for exceeding the size cap. */
  droppedEvents: number;
}

/**
 * Streamable HTTP transport v3.
 *
 * - `postJsonRpc` sends one JSON-RPC request and collects the answer:
 *   a single JSON object, or an SSE stream of JSON-RPC messages.
 *   A `202 Accepted` with an empty body means "accepted, the answer
 *   comes on the GET stream".
 * - `openGetStream` opens the GET SSE stream for server-initiated
 *   messages, resuming from the last seen event id, reconnecting on
 *   drop, and delivering parsed messages to the handler.
 * - `close()` stops the GET stream. There is no DELETE: stateless
 *   servers have no session to close. In legacy mode `closeLegacy()`
 *   sends the DELETE for old servers.
 */
export class StreamableHttpV3Transport {
  private readonly fetchFn: V3TransportFetchFn;
  private readonly protocolVersion: string;
  private readonly timeoutMs: number;
  private readonly legacyHttpSse: boolean;
  private readonly legacySessionId?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly resumeStore: V3ResumeStore;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private getStreamAbort: AbortController | null = null;
  private getStreamRunning = false;
  /** True when a request actually used the legacy path (for the log). */
  legacyUsed = false;

  constructor(options: StreamableHttpV3Options) {
    if (!options.fetchFn) {
      throw new StreamableHttpV3Error('NO_FETCH', 'StreamableHttpV3Transport needs a fetchFn');
    }
    this.fetchFn = options.fetchFn;
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026;
    this.timeoutMs = options.timeoutMs ?? STREAMABLE_HTTP_V3_TIMEOUT_MS;
    this.legacyHttpSse = options.legacyHttpSse ?? false;
    this.legacySessionId = options.legacySessionId;
    this.extraHeaders = { ...(options.extraHeaders ?? {}) };
    this.resumeStore = options.resumeStore ?? new V3ResumeStore();
    this.reconnectAttempts = options.reconnectAttempts ?? STREAMABLE_HTTP_V3_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? STREAMABLE_HTTP_V3_RECONNECT_DELAY_MS;
  }

  /** The resume store (shared with the caller for inspection). */
  getResumeStore(): V3ResumeStore {
    return this.resumeStore;
  }

  /** True while the GET stream is open. */
  isGetStreamOpen(): boolean {
    return this.getStreamRunning;
  }

  private validateUrl(url: string): void {
    if (!/^https?:\/\//.test(url)) {
      throw new StreamableHttpV3Error('BAD_URL', `Streamable HTTP needs an http(s) URL, got: ${url}`);
    }
  }

  private baseHeaders(): Record<string, string> {
    const headers = buildStatelessRequestHeaders(this.protocolVersion, this.extraHeaders);
    if (this.legacyHttpSse) {
      this.legacyUsed = true;
      if (this.legacySessionId) headers[MCP_SESSION_ID_HEADER] = this.legacySessionId;
    }
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new StreamableHttpV3Error('TIMEOUT', `Request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      throw new StreamableHttpV3Error(
        'FETCH_FAILED',
        `Request to ${url} failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a `MCP-Protocol-Version` response header (fetch Headers API). */
  private responseProtocolVersion(response: Response): string | null {
    try {
      const value = response.headers.get(MCP_PROTOCOL_VERSION_HEADER);
      return value ? value.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * POST one JSON-RPC request. Returns the messages the server sent
   * back (one JSON object, or the SSE stream's messages). Throws on
   * HTTP errors, timeouts, and malformed JSON.
   */
  async postJsonRpc(
    url: string,
    request: Record<string, unknown>,
  ): Promise<V3PostResult> {
    this.validateUrl(url);
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(request),
    });
    const serverProtocolVersion = this.responseProtocolVersion(response);
    if (response.status === 202) {
      return { mode: 'accepted', messages: [], status: 202, serverProtocolVersion, droppedEvents: 0 };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new StreamableHttpV3Error(
        'HTTP_ERROR',
        `POST ${url} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const { events, dropped } = parseV3SseChunk(text);
      const messages: V3TransportMessage[] = [];
      for (const event of events) {
        const parsed = parseV3SseJsonRpc(event);
        if (parsed) {
          messages.push({ message: parsed, eventId: event.id, eventType: event.event });
          this.resumeStore.record(url, event.id);
        }
      }
      return { mode: 'sse', messages, status: response.status, serverProtocolVersion, droppedEvents: dropped };
    }
    const text = await response.text();
    if (text.trim() === '') {
      return { mode: 'accepted', messages: [], status: response.status, serverProtocolVersion, droppedEvents: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StreamableHttpV3Error('BAD_JSON', `POST ${url} returned invalid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new StreamableHttpV3Error('BAD_JSON', `POST ${url} returned a non-object JSON response`);
    }
    return {
      mode: 'json',
      messages: [{ message: parsed as Record<string, unknown> }],
      status: response.status,
      serverProtocolVersion,
      droppedEvents: 0,
    };
  }

  /**
   * Open the GET SSE stream for server-initiated messages. Delivers
   * parsed JSON-RPC messages to `onMessage`; resumes from the last
   * seen event id; reconnects up to `reconnectAttempts` times when
   * the stream drops. Returns a `close()` function. The stream runs
   * until `close()` is called or the fetch rejects after all retries.
   */
  async openGetStream(
    url: string,
    onMessage: (message: V3TransportMessage) => void,
    onError?: (error: StreamableHttpV3Error) => void,
  ): Promise<() => void> {
    this.validateUrl(url);
    if (this.getStreamRunning) {
      throw new StreamableHttpV3Error('STREAM_OPEN', 'GET stream is already open');
    }
    this.getStreamRunning = true;
    const abort = new AbortController();
    this.getStreamAbort = abort;
    let attempt = 0;
    // Run the reconnect loop without blocking the caller.
    void (async () => {
      while (this.getStreamRunning && !abort.signal.aborted) {
        try {
          await this.runOneGetStream(url, abort, onMessage);
          break; // clean end of stream
        } catch (err) {
          if (abort.signal.aborted || !this.getStreamRunning) break;
          attempt += 1;
          if (attempt > this.reconnectAttempts) {
            const wrapped = err instanceof StreamableHttpV3Error
              ? err
              : new StreamableHttpV3Error('STREAM_FAILED', (err as Error).message);
            onError?.(wrapped);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs));
        }
      }
      this.getStreamRunning = false;
    })();
    return () => {
      this.getStreamRunning = false;
      abort.abort();
      this.getStreamAbort = null;
    };
  }

  private async runOneGetStream(
    url: string,
    abort: AbortController,
    onMessage: (message: V3TransportMessage) => void,
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      Accept: 'text/event-stream',
    };
    const lastId = this.resumeStore.lastEventId(url);
    if (lastId) headers['Last-Event-ID'] = lastId;
    const response = await this.fetchFn(url, { method: 'GET', headers, signal: abort.signal });
    if (response.status < 200 || response.status >= 300) {
      throw new StreamableHttpV3Error(
        'HTTP_ERROR',
        `GET ${url} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const text = await response.text();
    if (abort.signal.aborted) return;
    const { events, dropped } = parseV3SseChunk(text);
    void dropped;
    for (const event of events) {
      const parsed = parseV3SseJsonRpc(event);
      if (!parsed) continue;
      this.resumeStore.record(url, event.id);
      onMessage({ message: parsed, eventId: event.id, eventType: event.event });
    }
  }

  /** Stop the GET stream (no DELETE — stateless servers have no session). */
  close(): void {
    this.getStreamRunning = false;
    this.getStreamAbort?.abort();
    this.getStreamAbort = null;
  }

  /**
   * Legacy only: DELETE the session on a pre-2.0 server. Refused
   * when legacy mode is off — there is nothing to close in v3.
   */
  async closeLegacy(url: string): Promise<void> {
    if (!this.legacyHttpSse) {
      throw new StreamableHttpV3Error(
        'NO_SESSION',
        'closeLegacy is only available in legacy HTTP+SSE mode; stateless servers have no session to close',
      );
    }
    this.validateUrl(url);
    await this.fetchWithTimeout(url, { method: 'DELETE', headers: this.baseHeaders() });
  }
}

/**
 * Build a minimal in-memory fake fetch for tests: maps
 * `METHOD url` to a canned Response. No network is touched.
 */
export function buildFakeV3Fetch(
  handlers: Record<string, { status: number; contentType?: string; body: string; headers?: Record<string, string> }>,
): V3TransportFetchFn {
  return async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const handler = handlers[`${method} ${url}`];
    if (!handler) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const headers = new Headers({ 'content-type': handler.contentType ?? 'application/json' });
    for (const [key, value] of Object.entries(handler.headers ?? {})) headers.set(key, value);
    return new Response(handler.body, { status: handler.status, headers });
  };
}
