/**
 * MCP 2.0 stateless HTTP transport (v1.06, Đội T2).
 *
 * Spec 2026-07-28: một server MCP 2.0 là một web service stateless
 * bình thường — mỗi request là một HTTP POST độc lập, tự mang
 * protocol version + capabilities trong `_meta`, và KHÔNG có session
 * phía server. Transport này là lớp thực thi đúng cam kết đó:
 *
 *   - Mỗi JSON-RPC request đi bằng một POST riêng, không giữ gì
 *     giữa các request ngoài bộ đếm id.
 *   - KHÔNG BAO GIỜ gửi header `Mcp-Session-Id`, và KHÔNG BAO GIỜ
 *     lưu session id server trả về (nếu server cũ vẫn cấp session
 *     id thì header đó bị bỏ và ghi một notice — giá trị header
 *     không bao giờ được log, chỉ đếm số lần bị bỏ).
 *   - KHÔNG mở GET SSE stream dài (không có session để giữ), KHÔNG
 *     gửi DELETE session khi đóng — `close()` chỉ đánh dấu đóng ở
 *     phía client, không còn gì phía server để dọn.
 *   - Response SSE (`text/event-stream`) vẫn đọc được: frame cuối
 *     có `result`/`error` là response của request, các frame
 *     notification/request khác được dispatch qua `onServerMessage`
 *     (giống `transport.ts`, nhưng không giữ `lastEventId` vì không
 *     có stream để resume).
 *
 * Module này KHÔNG thay thế `StreamableHttpTransport` trong
 * `transport.ts` (transport đó vẫn phục vụ các server pre-2.0 cần
 * session + GET stream). Coordinator chọn transport này khi
 * negotiation ra mode `stateless` (xem `statelessClient.ts`); các
 * server cũ dùng handshake truyền thống vẫn đi transport cũ.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 * Không chạm network thật trong test: `fetchFn` được tiêm vào.
 */

import {
  buildStatelessMeta,
  MCP_PROTOCOL_VERSION_2026,
  withStatelessMeta,
  type StatelessClientCapabilities,
} from './stateless';

/** Timeout mặc định cho một request stateless (ms). */
export const DEFAULT_STATELESS_REQUEST_TIMEOUT_MS = 30_000;

/** Số lần tối đa ghi notice trùng loại (tránh spam log). */
export const STATELESS_NOTICE_MAX_SAME_KIND = 5;

/** Response tối thiểu transport cần (tương thích với fetch Response). */
export interface StatelessFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Hàm fetch được tiêm vào (mặc định là `fetch` toàn cục). */
export type StatelessFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<StatelessFetchResponse>;

/** Loại notice transport stateless có thể phát ra. */
export type StatelessTransportNoticeKind =
  | 'session-header-dropped'
  | 'http-error'
  | 'timeout'
  | 'invalid-response';

/** Một notice (không bao giờ chứa header/token/giá trị nhạy cảm). */
export interface StatelessTransportNotice {
  kind: StatelessTransportNoticeKind;
  /** Thông điệp đọc được (tiếng Việt, không chứa secret). */
  message: string;
  /** Số lần cùng loại đã xảy ra (kể cả lần này). */
  count: number;
  /** Thời điểm phát ra (ms epoch). */
  atMs: number;
}

export type StatelessTransportNoticeListener = (
  notice: StatelessTransportNotice,
) => void;

/** Lỗi của stateless transport (HTTP / timeout / JSON-RPC error). */
export class StatelessTransportError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;
  constructor(message: string, options: { code?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = 'StatelessTransportError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
  }
}

/** Cấu hình cho `StatelessHttpTransport`. */
export interface StatelessHttpTransportOptions {
  /** URL endpoint MCP (streamable HTTP) của server. */
  url: string;
  /** Hàm fetch (mặc định `fetch` toàn cục). Test tiêm fake vào đây. */
  fetchFn?: StatelessFetchFn;
  /** Timeout mỗi request (ms). Mặc định 30_000. */
  timeoutMs?: number;
  /** Protocol version khai trong `_meta` mỗi request. */
  protocolVersion?: string;
  /** Capabilities khai trong `_meta` mỗi request. */
  capabilities?: StatelessClientCapabilities;
  /** Client info khai trong `_meta` mỗi request. */
  clientInfo?: { name: string; version: string };
  /** Header tĩnh gửi kèm (vd `Authorization` đã có sẵn) — KHÔNG được chứa `Mcp-Session-Id` (sẽ bị bỏ). */
  headers?: Record<string, string>;
  /** Nghe notice (session header bị bỏ, HTTP error, timeout...). */
  onNotice?: StatelessTransportNoticeListener;
  /** Đồng hồ (test tiêm giờ cố định). */
  nowMs?: () => number;
}

/** Message do server gửi kèm trong response (notification/request). */
export interface StatelessServerMessage {
  method: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Header gửi cho một request stateless. Cố tình KHÔNG có
 * `Mcp-Session-Id` — caller nào truyền session id qua `headers`
 * cũng bị bỏ ở đây (và `StatelessHttpTransport` ghi notice).
 */
export function buildStatelessRequestHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key.toLowerCase() === 'mcp-session-id') continue;
    headers[key] = value;
  }
  return headers;
}

/** True khi headers chứa `Mcp-Session-Id` (bất kể hoa/thường). */
export function hasSessionIdHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'mcp-session-id');
}

/**
 * Build một JSON-RPC request stateless: body `{ jsonrpc, id, method,
 * params }` với `params._meta` mang protocol version + capabilities.
 * Params gốc không bị mutate.
 */
export function buildStatelessJsonRpcRequest(
  id: number,
  method: string,
  params: Record<string, unknown> | undefined,
  metaOptions: {
    protocolVersion?: string;
    capabilities?: StatelessClientCapabilities;
    clientInfo?: { name: string; version: string };
  } = {},
): Record<string, unknown> {
  const meta = buildStatelessMeta(metaOptions);
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: withStatelessMeta(params, meta),
  };
}

export interface ParsedStatelessResponse {
  /** `result` của response (khi thành công). */
  result?: unknown;
  /** JSON-RPC error (khi server trả lỗi). */
  error?: { code: number; message: string; data?: unknown };
  /** Các message server-initiated kèm trong response SSE. */
  serverMessages: StatelessServerMessage[];
}

/**
 * Parse body của một response POST stateless. Hỗ trợ JSON thuần và
 * SSE (`text/event-stream`): frame cuối có `result`/`error` là
 * response của request; các frame còn lại là server message.
 * Trả null khi body rỗng (server chỉ trả 202 — không có response).
 * Ném `StatelessTransportError` khi JSON hỏng hoặc frame không phải
 * JSON-RPC response.
 */
export function parseStatelessResponseBody(
  text: string,
  contentType: string,
  expectedId: number,
): ParsedStatelessResponse | null {
  if (!text.trim()) return null;
  const isSse =
    contentType.includes('text/event-stream') || text.includes('data:');
  if (!isSse) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StatelessTransportError('Stateless: response không phải JSON hợp lệ.');
    }
    return parseStatelessJsonRpcMessage(parsed, expectedId, []);
  }
  const serverMessages: StatelessServerMessage[] = [];
  let response: ParsedStatelessResponse | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (typeof parsed['method'] === 'string') {
      serverMessages.push({
        method: parsed['method'] as string,
        ...(isRecord(parsed['params']) ? { params: parsed['params'] } : {}),
      });
      continue;
    }
    if ('result' in parsed || 'error' in parsed) {
      response = parseStatelessJsonRpcMessage(parsed, expectedId, serverMessages);
    }
  }
  if (!response) {
    // SSE chỉ toàn notification, không có response cho request này.
    return { serverMessages };
  }
  return response;
}

function parseStatelessJsonRpcMessage(
  parsed: unknown,
  expectedId: number,
  serverMessages: StatelessServerMessage[],
): ParsedStatelessResponse {
  if (!isRecord(parsed)) {
    throw new StatelessTransportError('Stateless: response không phải JSON-RPC object.');
  }
  if (parsed['id'] !== expectedId) {
    throw new StatelessTransportError(
      `Stateless: response id (${String(parsed['id'])}) không khớp request id (${expectedId}).`,
    );
  }
  if ('error' in parsed && isRecord(parsed['error'])) {
    const err = parsed['error'];
    return {
      error: {
        code: typeof err['code'] === 'number' ? err['code'] : -32603,
        message: typeof err['message'] === 'string' ? err['message'] : 'Unknown JSON-RPC error',
        ...(err['data'] !== undefined ? { data: err['data'] } : {}),
      },
      serverMessages,
    };
  }
  if (!('result' in parsed)) {
    throw new StatelessTransportError('Stateless: response không có result cũng không có error.');
  }
  return { result: parsed['result'], serverMessages };
}

/**
 * Stateless HTTP transport: POST-only, không session, không GET
 * stream, không DELETE. Mỗi `requestJsonRpc` là một request độc lập.
 */
export class StatelessHttpTransport {
  readonly url: string;
  private readonly fetchFn: StatelessFetchFn;
  private readonly timeoutMs: number;
  private readonly protocolVersion: string;
  private readonly capabilities?: StatelessClientCapabilities;
  private readonly clientInfo?: { name: string; version: string };
  private readonly staticHeaders: Record<string, string>;
  private readonly onNotice?: StatelessTransportNoticeListener;
  private readonly nowMs: () => number;
  private nextId = 1;
  private closed = false;
  private readonly noticeCounts = new Map<StatelessTransportNoticeKind, number>();
  private readonly notices: StatelessTransportNotice[] = [];
  /** Server message kèm trong response gần nhất (notification/request). */
  onServerMessage?: (message: StatelessServerMessage) => void;

  constructor(options: StatelessHttpTransportOptions) {
    if (!options.url) {
      throw new StatelessTransportError('Stateless: cần url của MCP server.');
    }
    this.url = options.url;
    this.fetchFn =
      options.fetchFn ??
      ((globalThis.fetch as unknown) as StatelessFetchFn);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STATELESS_REQUEST_TIMEOUT_MS;
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026;
    this.capabilities = options.capabilities;
    this.clientInfo = options.clientInfo;
    this.staticHeaders = { ...(options.headers ?? {}) };
    // Gán onNotice/nowMs TRƯỚC khi kiểm tra header tĩnh: emitNotice
    // trong constructor cần cả hai (lỗi thật v1.06: gán sau → crash).
    this.onNotice = options.onNotice;
    this.nowMs = options.nowMs ?? Date.now;
    if (hasSessionIdHeader(this.staticHeaders)) {
      // Caller lỡ truyền session id tĩnh: bỏ ngay, ghi notice một lần.
      for (const key of Object.keys(this.staticHeaders)) {
        if (key.toLowerCase() === 'mcp-session-id') delete this.staticHeaders[key];
      }
      this.emitNotice(
        'session-header-dropped',
        'Stateless: đã bỏ header Mcp-Session-Id tĩnh trong cấu hình (transport stateless không dùng session).',
      );
    }
  }

  /** Transport đã đóng chưa (đóng rồi thì mọi request đều lỗi). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Số request đã gửi (đếm id — mỗi request một id tăng dần). */
  get requestsSent(): number {
    return this.nextId - 1;
  }

  /** Các notice đã phát (bản sao — caller không mutate được nội bộ). */
  getNotices(): StatelessTransportNotice[] {
    return [...this.notices];
  }

  /** Số lần server trả header `Mcp-Session-Id` (đã bị bỏ). */
  get droppedSessionHeaders(): number {
    return this.noticeCounts.get('session-header-dropped') ?? 0;
  }

  private emitNotice(kind: StatelessTransportNoticeKind, message: string): void {
    const count = (this.noticeCounts.get(kind) ?? 0) + 1;
    this.noticeCounts.set(kind, count);
    const notice: StatelessTransportNotice = {
      kind,
      message,
      count,
      atMs: this.nowMs(),
    };
    this.notices.push(notice);
    // Tránh spam log: cùng loại chỉ báo ra ngoài vài lần đầu.
    if (count <= STATELESS_NOTICE_MAX_SAME_KIND) {
      this.onNotice?.(notice);
    }
  }

  /**
   * Gửi một JSON-RPC request stateless và trả `result`. Ném
   * `StatelessTransportError` khi: transport đã đóng, timeout,
   * HTTP status lỗi, body không parse được, hoặc server trả
   * JSON-RPC error (code giữ nguyên trong `error.code`).
   */
  async requestJsonRpc(
    method: string,
    params?: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new StatelessTransportError('Stateless: transport đã đóng.');
    }
    if (!method) {
      throw new StatelessTransportError('Stateless: method không được rỗng.');
    }
    // Signal đã abort TRƯỚC khi gọi: listener 'abort' sẽ không bao
    // giờ bắn nữa, nên kiểm tra ngay thay vì gửi request rồi mới lỗi.
    if (options.signal?.aborted) {
      throw new StatelessTransportError(`Stateless: request "${method}" đã bị huỷ.`);
    }
    const id = this.nextId;
    this.nextId += 1;
    const body = buildStatelessJsonRpcRequest(id, method, params, {
      protocolVersion: this.protocolVersion,
      ...(this.capabilities ? { capabilities: this.capabilities } : {}),
      ...(this.clientInfo ? { clientInfo: this.clientInfo } : {}),
    });
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onCallerAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: buildStatelessRequestHeaders(this.staticHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Server stateless KHÔNG được cấp session id. Server nào vẫn
      // trả header này (server cũ / server lai) thì bỏ header, không
      // lưu, không gửi lại ở request sau — và ghi notice để operator
      // biết server đó chưa thuần stateless.
      if (res.headers.get('mcp-session-id') !== null) {
        this.emitNotice(
          'session-header-dropped',
          'Stateless: server trả header Mcp-Session-Id — đã bỏ, không lưu session.',
        );
      }
      if (res.status === 401 || res.status === 403) {
        this.emitNotice(
          'http-error',
          `Stateless: server trả HTTP ${res.status} cho "${method}" (cần xác thực lại).`,
        );
        throw new StatelessTransportError(
          `Stateless: server trả HTTP ${res.status} cho "${method}".`,
          { httpStatus: res.status },
        );
      }
      if (res.status < 200 || res.status >= 300) {
        this.emitNotice(
          'http-error',
          `Stateless: server trả HTTP ${res.status} cho "${method}".`,
        );
        throw new StatelessTransportError(
          `Stateless: server trả HTTP ${res.status} cho "${method}".`,
          { httpStatus: res.status },
        );
      }
      const text = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      const parsed = parseStatelessResponseBody(text, contentType, id);
      if (!parsed) {
        // 202 rỗng: server nhận rồi, không có result — với request
        // cần trả lời thì đây là lỗi protocol.
        throw new StatelessTransportError(
          `Stateless: server trả response rỗng cho "${method}".`,
          { httpStatus: res.status },
        );
      }
      for (const message of parsed.serverMessages) {
        try {
          this.onServerMessage?.(message);
        } catch {
          // Handler của caller lỗi không được làm chết request.
        }
      }
      if (parsed.error) {
        throw new StatelessTransportError(
          `Stateless: "${method}" lỗi ${parsed.error.code}: ${parsed.error.message}`,
          { code: parsed.error.code, httpStatus: res.status },
        );
      }
      if (!('result' in parsed)) {
        // SSE chỉ toàn notification, không có response cho request
        // này — coi như lỗi protocol thay vì trả undefined lặng lẽ.
        throw new StatelessTransportError(
          `Stateless: server trả response không có result cho "${method}".`,
          { httpStatus: res.status },
        );
      }
      return parsed.result;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new StatelessTransportError(`Stateless: request "${method}" đã bị huỷ.`);
        }
        this.emitNotice(
          'timeout',
          `Stateless: request "${method}" hết thời gian sau ${timeoutMs}ms.`,
        );
        throw new StatelessTransportError(
          `Stateless: request "${method}" hết thời gian sau ${timeoutMs}ms.`,
        );
      }
      if (err instanceof StatelessTransportError) throw err;
      throw new StatelessTransportError(
        `Stateless: request "${method}" thất bại: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Đóng transport. Không gửi DELETE, không mở/đóng stream — phía
   * server stateless không giữ gì để dọn, nên đóng chỉ là đánh dấu
   * ở phía client. Gọi nhiều lần vẫn an toàn.
   */
  close(): void {
    this.closed = true;
  }
}
