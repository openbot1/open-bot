/**
 * Stateless client v16 — MCP 2026-07-28 "MCP 2.0" (v1.36, Đội T3).
 *
 * Sóng trước đã có client stateless đầy đủ (`statelessClientFull.ts`,
 * v1.05): một endpoint, `connect()` rồi `call()`, fallback handshake
 * cho server cũ. V16 xây lớp mới trên đó cho đội hình server hiện đại:
 *
 *   1. Client stateless thuần — KHÔNG bao giờ handshake `initialize`
 *      và KHÔNG bao giờ gửi header `Mcp-Session-Id`. Mọi request tự
 *      mang protocol version + capabilities trong `_meta`
 *      (SEP-2567/SEP-2575). Server cũ không biết `server/discover`
 *      thì bị từ chối rõ ràng thay vì fallback handshake âm thầm —
 *      fallback handshake là đường của v1.05, v16 không dùng nữa.
 *   2. Endpoint pool + round-robin load balancing: nhiều URL server
 *      (cùng một dịch vụ sau load balancer, hoặc nhiều replica),
 *      đánh dấu endpoint lỗi sau N lần fail liên tiếp và tự hồi phục
 *      sau thời gian chờ; request lỗi transient được thử lại ở
 *      endpoint khỏe tiếp theo.
 *   3. `server/discover` chạy trước mọi lời gọi khác và được cache
 *      theo endpoint (TTL); discover trả về extensions đã thương
 *      lượng (xem `extensionsV16.ts`) để caller kiểm tra trước khi
 *      gọi một method cần extension.
 *   4. Idempotency key riêng cho mỗi request (UUID v4) để server
 *      phân biệt retry với gọi mới; retry chỉ áp dụng cho lỗi
 *      transient (timeout / 502 / 503 / 429), không retry lỗi
 *      nghiệp vụ.
 *
 * Module này không chạm mạng: nó lái một transport tối thiểu
 * (`V16StatelessTransport`) mà test dùng fake, coordinator nối vào
 * transport HTTP thật. Ideas only — không copy code/text/tài sản
 * của bất kỳ repo nào, của xAI/Cursor.
 */

import { randomUUID } from 'node:crypto';
import {
  MCP_PROTOCOL_VERSION_2026,
  buildStatelessMeta,
  negotiateStatelessVersion,
  parseServerDiscoverResult,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
} from './stateless';
import { MCP_SESSION_ID_HEADER, stripSessionIdHeader } from './statelessClientFull';

/** Protocol version mặc định của client v16. */
export const MCP_V16_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION_2026;

/** Method discovery của MCP 2.0. */
export const MCP_V16_DISCOVER_METHOD = 'server/discover';

/** Số lần fail liên tiếp trước khi một endpoint bị đánh dấu unhealthy. */
export const V16_ENDPOINT_MAX_FAILURES = 3;

/** Thời gian chờ (ms) trước khi thử lại một endpoint unhealthy. */
export const V16_ENDPOINT_COOLDOWN_MS = 30_000;

/** Số lần retry tối đa cho một request (không tính lần gọi đầu). */
export const V16_MAX_RETRIES_DEFAULT = 2;

/** Lỗi của stateless client v16. */
export class StatelessClientV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'StatelessClientV16Error';
    if (code) this.code = code;
  }
}

/** Một endpoint server trong pool. */
export interface V16StatelessEndpoint {
  /** URL gốc của server, vd `https://mcp.example.com/rpc`. */
  url: string;
  /** Trọng số round-robin (mặc định 1; 0 = chỉ dùng khi failover). */
  weight?: number;
  /** Endpoint có đang khỏe không (do pool tự cập nhật). */
  healthy?: boolean;
  /** Số lần fail liên tiếp (do pool tự cập nhật). */
  consecutiveFailures?: number;
  /** Thời điểm (ms epoch) lần fail cuối (do pool tự cập nhật). */
  lastFailureAtMs?: number;
}

/** Trạng thái runtime của một endpoint trong pool. */
export interface V16EndpointState {
  url: string;
  weight: number;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureAtMs: number | null;
  totalCalls: number;
  totalFailures: number;
}

/**
 * Pool endpoint với round-robin có trọng số + health marking.
 * Luôn trả endpoint khỏe; khi mọi endpoint đều unhealthy thì trả
 * endpoint "ít tệ nhất" (fail lâu nhất) để vẫn thử được một lần
 * thay vì chết ngay — caller quyết định retry hay báo lỗi.
 */
export class V16EndpointPool {
  private readonly states: V16EndpointState[];
  private cursor = 0;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    endpoints: V16StatelessEndpoint[],
    options: {
      maxFailures?: number;
      cooldownMs?: number;
      now?: () => number;
    } = {},
  ) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new StatelessClientV16Error(
        'Stateless client v16 cần ít nhất một endpoint.',
        'no-endpoints',
      );
    }
    const seen = new Set<string>();
    for (const ep of endpoints) {
      if (typeof ep.url !== 'string' || ep.url.length === 0) {
        throw new StatelessClientV16Error('Endpoint URL rỗng.', 'bad-endpoint');
      }
      if (seen.has(ep.url)) {
        throw new StatelessClientV16Error(
          `Endpoint trùng lặp trong pool: ${ep.url}`,
          'duplicate-endpoint',
        );
      }
      seen.add(ep.url);
    }
    this.maxFailures = options.maxFailures ?? V16_ENDPOINT_MAX_FAILURES;
    this.cooldownMs = options.cooldownMs ?? V16_ENDPOINT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.states = endpoints.map((ep) => ({
      url: ep.url,
      weight: Math.max(0, ep.weight ?? 1),
      healthy: ep.healthy !== false,
      consecutiveFailures: ep.consecutiveFailures ?? 0,
      lastFailureAtMs: ep.lastFailureAtMs ?? null,
      totalCalls: 0,
      totalFailures: 0,
    }));
  }

  /** Snapshot trạng thái (bản sao, để quan sát / test). */
  snapshot(): V16EndpointState[] {
    return this.states.map((s) => ({ ...s }));
  }

  /** Số endpoint đang khỏe (tính cả endpoint hết cooldown). */
  healthyCount(nowMs?: number): number {
    const now = nowMs ?? this.now();
    return this.states.filter((s) => this.isHealthy(s, now)).length;
  }

  private isHealthy(state: V16EndpointState, nowMs: number): boolean {
    // Dưới ngưỡng fail thì khỏe. Đủ ngưỡng thì chỉ khỏe lại khi đã
    // hết cooldown (cho probe một lần) — cờ `healthy` chỉ là
    // snapshot cho operator, không dùng để chặn probe.
    if (state.consecutiveFailures < this.maxFailures) return true;
    return (
      state.lastFailureAtMs !== null && nowMs - state.lastFailureAtMs >= this.cooldownMs
    );
  }

  /**
   * Endpoint tiếp theo theo round-robin có trọng số, chỉ chọn
   * endpoint khỏe. Trả null khi pool rỗng (không bao giờ xảy ra
   * vì constructor đã chặn) — giữ chữ ký an toàn cho caller.
   */
  next(): V16EndpointState | null {
    const now = this.now();
    const healthy = this.states.filter((s) => this.isHealthy(s, now) && s.weight > 0);
    const candidates = healthy.length > 0 ? healthy : this.states.filter((s) => s.weight > 0);
    if (candidates.length === 0) return null;
    // Round-robin có trọng số: lặp lại endpoint theo weight.
    const expanded: V16EndpointState[] = [];
    for (const s of candidates) {
      for (let i = 0; i < s.weight; i++) expanded.push(s);
    }
    const picked = expanded[this.cursor % expanded.length];
    this.cursor = (this.cursor + 1) % expanded.length;
    return picked;
  }

  /** Ghi nhận một lần gọi thành công: reset bộ đếm fail. */
  markSuccess(url: string): void {
    const state = this.states.find((s) => s.url === url);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.lastFailureAtMs = null;
    state.healthy = true;
    state.totalCalls += 1;
  }

  /** Ghi nhận một lần gọi lỗi: tăng fail, đánh unhealthy khi đủ ngưỡng. */
  markFailure(url: string): void {
    const state = this.states.find((s) => s.url === url);
    if (!state) return;
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    state.totalCalls += 1;
    state.lastFailureAtMs = this.now();
    if (state.consecutiveFailures >= this.maxFailures) state.healthy = false;
  }

  /** Ép một endpoint khỏe lại (vd sau khi operator sửa server). */
  forceHealthy(url: string): boolean {
    const state = this.states.find((s) => s.url === url);
    if (!state) return false;
    state.healthy = true;
    state.consecutiveFailures = 0;
    state.lastFailureAtMs = null;
    return true;
  }
}

/** Transport tối thiểu mà client v16 lái (test dùng fake). */
export interface V16StatelessTransport {
  /**
   * Gửi một JSON-RPC request tới endpoint. Ném `V16TransportError`
   * (hoặc bất kỳ Error nào có `transient: true`) khi lỗi transient
   * để client retry ở endpoint khác; lỗi khác được xem là lỗi
   * nghiệp vụ và không retry.
   */
  request(
    endpointUrl: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<unknown>;
}

/** Lỗi transport có cờ transient để client v16 biết có retry không. */
export class V16TransportError extends Error {
  readonly transient: boolean;
  readonly status?: number;
  constructor(message: string, options: { transient?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'V16TransportError';
    this.transient = options.transient ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** Tuỳ chọn khi tạo StatelessClientV16. */
export interface StatelessClientV16Options {
  /** Protocol version ưu tiên (mặc định 2026-07-28). */
  protocolVersion?: string;
  /** Capabilities client khai trong `_meta` mỗi request. */
  capabilities?: StatelessClientCapabilities;
  /** Tên/version client ghi vào `_meta.clientInfo`. */
  clientInfo?: { name: string; version: string };
  /** Số lần retry tối đa cho lỗi transient (mặc định 2). */
  maxRetries?: number;
  /** TTL cache discover theo endpoint (ms, mặc định 60s). */
  discoverTtlMs?: number;
  /** Đồng hồ (để test điều khiển thời gian). */
  now?: () => number;
}

/** Kết quả một lần gọi qua client v16. */
export interface V16CallResult {
  /** Endpoint đã trả lời. */
  endpointUrl: string;
  /** Protocol version server đã dùng. */
  protocolVersion: string;
  /** Số lần đã thử (1 = thành công ngay lần đầu). */
  attempts: number;
  /** Kết quả thô từ server. */
  result: unknown;
}

/** Một envelope JSON-RPC stateless v16 (đã gắn `_meta`). */
export interface V16RequestEnvelope {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Dựng envelope JSON-RPC cho một request stateless v16: gắn
 * `_meta` (protocolVersion + capabilities + clientInfo +
 * idempotencyKey) vào params và header không chứa session id.
 * Hàm thuần — dùng được cả khi không cần pool/client.
 */
export function buildV16RequestEnvelope(
  method: string,
  params: Record<string, unknown> | undefined,
  options: {
    protocolVersion?: string;
    capabilities?: StatelessClientCapabilities;
    clientInfo?: { name: string; version: string };
    requestId?: string;
    idempotencyKey?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): V16RequestEnvelope {
  if (typeof method !== 'string' || method.length === 0) {
    throw new StatelessClientV16Error('Method rỗng.', 'bad-method');
  }
  if (method === 'initialize') {
    throw new StatelessClientV16Error(
      'Client stateless v16 không bao giờ gọi initialize (MCP 2026-07-28 bỏ handshake).',
      'initialize-forbidden',
    );
  }
  const protocolVersion = options.protocolVersion ?? MCP_V16_PROTOCOL_VERSION;
  const meta = buildStatelessMeta({
    protocolVersion,
    capabilities: options.capabilities,
    clientInfo: options.clientInfo,
  });
  const paramsWithMeta: Record<string, unknown> = {
    ...(params ?? {}),
    _meta: {
      ...(meta as unknown as Record<string, unknown>),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    },
  };
  const headers = stripSessionIdHeader({
    'content-type': 'application/json',
    ...(options.extraHeaders ?? {}),
  });
  assertNoSessionIdHeader(headers);
  return {
    jsonrpc: '2.0',
    id: options.requestId ?? randomUUID(),
    method,
    params: paramsWithMeta,
    headers,
  };
}

/**
 * Ném khi một header set còn chứa `Mcp-Session-Id` (so khớp không
 * phân biệt hoa thường). Dùng sau mọi bước dựng header để đảm bảo
 * không một lớp nào vô tình gắn lại session id.
 */
export function assertNoSessionIdHeader(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === MCP_SESSION_ID_HEADER.toLowerCase()) {
      throw new StatelessClientV16Error(
        `Header ${MCP_SESSION_ID_HEADER} bị cấm ở client stateless v16 — request phải tự mang protocol version + capabilities trong _meta.`,
        'session-header-forbidden',
      );
    }
  }
}

/**
 * Parse kết quả `server/discover` cho client v16: dùng parser của
 * `stateless.ts` rồi kiểm tra thêm version đã thương lượng có nằm
 * trong danh sách server hỗ trợ không.
 */
export function parseV16DiscoverResult(value: unknown): ServerDiscoverResult {
  const parsed = parseServerDiscoverResult(value);
  const negotiated = negotiateStatelessVersion(
    parsed.protocolVersion,
    parsed.supportedVersions ?? [parsed.protocolVersion],
  );
  if (!negotiated) {
    throw new StatelessClientV16Error(
      `Server không hỗ trợ protocol version ${parsed.protocolVersion} (hỗ trợ: ${(parsed.supportedVersions ?? []).join(', ') || 'không rõ'}).`,
      'version-mismatch',
    );
  }
  return parsed;
}

/** Client stateless v16: pool endpoint + discover cache + retry. */
export class StatelessClientV16 {
  private readonly pool: V16EndpointPool;
  private readonly transport: V16StatelessTransport;
  private readonly protocolVersion: string;
  private readonly capabilities?: StatelessClientCapabilities;
  private readonly clientInfo?: { name: string; version: string };
  private readonly maxRetries: number;
  private readonly discoverTtlMs: number;
  private readonly now: () => number;
  private readonly discoverCache = new Map<
    string,
    { result: ServerDiscoverResult; atMs: number }
  >();

  constructor(
    endpoints: V16StatelessEndpoint[],
    transport: V16StatelessTransport,
    options: StatelessClientV16Options = {},
  ) {
    if (!transport || typeof transport.request !== 'function') {
      throw new StatelessClientV16Error('Thiếu transport.', 'no-transport');
    }
    this.pool = new V16EndpointPool(endpoints, { now: options.now });
    this.transport = transport;
    this.protocolVersion = options.protocolVersion ?? MCP_V16_PROTOCOL_VERSION;
    this.capabilities = options.capabilities;
    this.clientInfo = options.clientInfo;
    this.maxRetries = options.maxRetries ?? V16_MAX_RETRIES_DEFAULT;
    this.discoverTtlMs = options.discoverTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Snapshot pool (quan sát / test). */
  poolSnapshot(): V16EndpointState[] {
    return this.pool.snapshot();
  }

  /** Số endpoint khỏe hiện tại. */
  healthyEndpoints(): number {
    return this.pool.healthyCount();
  }

  /**
   * `server/discover` ở một endpoint (có cache theo TTL). Server
   * không biết discover (trả lỗi method-not-found) thì ném lỗi
   * `discover-unsupported` — v16 KHÔNG fallback handshake.
   */
  async discover(endpointUrl?: string): Promise<ServerDiscoverResult> {
    const target = endpointUrl ?? this.pool.next()?.url;
    if (!target) {
      throw new StatelessClientV16Error('Pool không còn endpoint.', 'no-endpoints');
    }
    const cached = this.discoverCache.get(target);
    if (cached && this.now() - cached.atMs < this.discoverTtlMs) return cached.result;
    const envelope = buildV16RequestEnvelope(MCP_V16_DISCOVER_METHOD, undefined, {
      protocolVersion: this.protocolVersion,
      capabilities: this.capabilities,
      clientInfo: this.clientInfo,
    });
    let raw: unknown;
    try {
      raw = await this.transport.request(target, envelope as unknown as Record<string, unknown>, envelope.headers);
    } catch (err) {
      this.pool.markFailure(target);
      throw err instanceof Error
        ? err
        : new StatelessClientV16Error(String(err), 'discover-failed');
    }
    if (raw !== null && typeof raw === 'object' && 'error' in (raw as Record<string, unknown>)) {
      const errObj = (raw as Record<string, unknown>)['error'] as Record<string, unknown>;
      const code = typeof errObj['code'] === 'number' ? (errObj['code'] as number) : 0;
      if (code === -32601) {
        throw new StatelessClientV16Error(
          `Server ${target} không hỗ trợ server/discover (MCP pre-2.0) — client v16 từ chối, không fallback handshake.`,
          'discover-unsupported',
        );
      }
      throw new StatelessClientV16Error(
        `server/discover lỗi: ${String(errObj['message'] ?? code)}`,
        'discover-failed',
      );
    }
    const parsed = parseV16DiscoverResult(raw);
    this.discoverCache.set(target, { result: parsed, atMs: this.now() });
    this.pool.markSuccess(target);
    return parsed;
  }

  /** Discover tất cả endpoint trong pool (mỗi endpoint một lần). */
  async discoverAll(): Promise<Map<string, ServerDiscoverResult>> {
    const out = new Map<string, ServerDiscoverResult>();
    for (const state of this.pool.snapshot()) {
      try {
        out.set(state.url, await this.discover(state.url));
      } catch {
        // Endpoint lỗi thì bỏ qua ở discoverAll; lỗi chi tiết nằm
        // trong pool snapshot (healthy=false) để caller tự xem.
      }
    }
    return out;
  }

  /** Xoá cache discover (vd sau khi server đổi capabilities). */
  clearDiscoverCache(endpointUrl?: string): void {
    if (endpointUrl) this.discoverCache.delete(endpointUrl);
    else this.discoverCache.clear();
  }

  /**
   * Gọi một method qua pool: envelope stateless cho mỗi lần thử;
   * lỗi transient thì retry ở endpoint khỏe tiếp theo, giữ nguyên
   * idempotency key để server không chạy handler hai lần.
   * (Discover chạy riêng qua `discover()` / `discoverAll()` và được
   * cache — `call()` không tự discover để mỗi lần gọi không tốn
   * thêm một round-trip.)
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<V16CallResult> {
    if (method === MCP_V16_DISCOVER_METHOD) {
      const result = await this.discover();
      return { endpointUrl: '', protocolVersion: result.protocolVersion, attempts: 1, result };
    }
    const idempotencyKey = randomUUID();
    const requestId = randomUUID();
    let lastError: unknown = null;
    const attempts = this.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const endpoint = this.pool.next();
      if (!endpoint) {
        throw new StatelessClientV16Error('Pool không còn endpoint khỏe.', 'no-endpoints');
      }
      const envelope = buildV16RequestEnvelope(method, params, {
        protocolVersion: this.protocolVersion,
        capabilities: this.capabilities,
        clientInfo: this.clientInfo,
        requestId,
        idempotencyKey,
      });
      try {
        const raw = await this.transport.request(
          endpoint.url,
          envelope as unknown as Record<string, unknown>,
          envelope.headers,
        );
        this.pool.markSuccess(endpoint.url);
        if (raw !== null && typeof raw === 'object' && 'error' in (raw as Record<string, unknown>)) {
          const errObj = (raw as Record<string, unknown>)['error'] as Record<string, unknown>;
          throw new StatelessClientV16Error(
            `Server trả lỗi ${String(errObj['code'] ?? '')}: ${String(errObj['message'] ?? 'unknown')}`,
            'server-error',
          );
        }
        return {
          endpointUrl: endpoint.url,
          protocolVersion: this.protocolVersion,
          attempts: attempt + 1,
          result: raw,
        };
      } catch (err) {
        this.pool.markFailure(endpoint.url);
        lastError = err;
        if (!isTransientV16Error(err) || attempt === attempts - 1) throw err;
        // Còn lượt retry: sang endpoint khỏe tiếp theo, giữ nguyên
        // idempotency key + request id.
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new StatelessClientV16Error(String(lastError), 'call-failed');
  }
}

/** True khi lỗi được coi là transient (đáng retry ở endpoint khác). */
export function isTransientV16Error(err: unknown): boolean {
  if (err instanceof V16TransportError) return err.transient;
  if (err instanceof StatelessClientV16Error) return false;
  if (err instanceof Error) {
    const withTransient = err as Error & { transient?: unknown; status?: unknown };
    if (withTransient.transient === true) return true;
    if (typeof withTransient.status === 'number') {
      return [408, 429, 502, 503, 504].includes(withTransient.status as number);
    }
    return /timeout|timed out|ECONNRESET|EAI_AGAIN|socket hang up/i.test(err.message);
  }
  return false;
}
