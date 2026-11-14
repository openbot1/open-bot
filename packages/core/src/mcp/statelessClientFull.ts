/**
 * MCP 2.0 stateless client hoàn chỉnh (v1.05, sóng T2).
 *
 * `stateless.ts` (v0.97) xây các primitive (`server/discover`,
 * `_meta` từng request) và `statelessClient.ts` (v1.04) xây thương
 * lượng `auto` — nhưng chưa có một client hoàn chỉnh gom tất cả
 * lại: một class duy nhất mà coordinator chỉ cần `connect()` rồi
 * `call()` / `callTool()` / `discover()`, với các đảm bảo sau:
 *
 *   1. Không bao giờ handshake `initialize` khi đang ở stateless
 *      mode — `connect()` chỉ gọi `server/discover`; server cũ
 *      (không biết discover) được xử lý qua negotiation flag
 *      (`mode: 'auto'` → fallback handshake, `mode: true` →
 *      stateless-only, `mode: false` → handshake thuần).
 *   2. Không bao giờ gửi header `Mcp-Session-Id` — mọi request
 *      đều tự mang protocol version + capabilities trong `_meta`
 *      (`buildStatelessMeta`), và `buildStatelessHeaders()` loại
 *      bỏ header session khỏi mọi header set (phòng khi một lớp
 *      dưới vô tình thêm vào, hoặc server trả session id trong
 *      response — client stateless không lưu nó).
 *   3. `server/discover` chạy trước mọi lời gọi khác: kết quả
 *      discovery (capabilities + protocol version + extensions)
 *      được cache trong client và dùng để kiểm tra trước khi gọi
 *      (vd gọi `tasks/*` khi server không khai tasks → lỗi rõ
 *      ràng thay vì chờ server trả -32601).
 *   4. Fallback tương thích server MCP cũ: negotiation flag ghi
 *      lại đúng đường đã đi (`StatelessNegotiation`), và khi ở
 *      handshake mode thì client hành xử như client 2025-11-25
 *      bình thường (không ép `_meta` stateless vào request).
 *
 * Module này không chạm mạng: nó lái một transport tối thiểu
 * (`requestJsonRpc` + `discover` + `initialize` + `close`) nên
 * test dùng fake transport. Client thật (stdio / streamable HTTP
 * trong `client.ts`) đã có sẵn `discover()` / `initialize()` /
 * `requestJsonRpc()` và được nối vào qua adapter ở coordinator.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào,
 * của xAI/Cursor.
 */

import {
  MCP_PROTOCOL_VERSION_2026,
  buildStatelessMeta,
  discoverServer,
  negotiateStatelessVersion,
  parseServerDiscoverResult,
  requestStateless,
  withStatelessMeta,
  type ServerDiscoverResult,
  type StatelessClientCapabilities,
  type StatelessRequestMeta,
} from './stateless';
import {
  negotiateStatelessConnection,
  type StatelessConnectMode,
  type StatelessNegotiatedMode,
  type StatelessNegotiation,
} from './statelessClient';

/** Transport tối thiểu mà StatelessMcpClient lái. */
export interface StatelessFullTransport {
  /** Gọi JSON-RPC thô (client thật: requestJsonRpc). */
  requestJsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** `server/discover` — có thể vắng ở transport cũ (khi đó dùng discoverServer). */
  discover?: () => Promise<ServerDiscoverResult | null>;
  /** Handshake `initialize` — chỉ dùng khi fallback về server cũ. */
  initialize?: () => Promise<{ protocolVersion?: string }>;
  /** Đóng transport. */
  close?: () => Promise<void> | void;
}

/** Trạng thái kết nối của StatelessMcpClient. */
export type StatelessClientState = 'idle' | 'connected' | 'closed';

/** Tuỳ chọn khi tạo StatelessMcpClient. */
export interface StatelessClientOptions {
  /**
   * Chế độ kết nối (xem `StatelessConnectMode`):
   *  - `'auto'` (mặc định, khuyến nghị): thử `server/discover`,
   *    fallback handshake khi server pre-2.0.
   *  - `true`: stateless-only, không bao giờ handshake.
   *  - `false`: handshake thuần (client 2025-11-25).
   */
  mode?: StatelessConnectMode;
  /** Protocol version ưu tiên khi thương lượng (mặc định 2026-07-28). */
  protocolVersion?: string;
  /** Capabilities client khai trong `_meta` mỗi request. */
  capabilities?: StatelessClientCapabilities;
  /** Tên/version client ghi vào `_meta.clientInfo`. */
  clientInfo?: { name: string; version: string };
  /** Timeout (ms) cho một lần discover (mặc định 10s). */
  discoverTimeoutMs?: number;
}

/** Lỗi của StatelessMcpClient. */
export class StatelessClientError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'StatelessClientError';
    if (code) this.code = code;
  }
}

/** Tên header session mà stateless client không bao giờ được gửi. */
export const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';

/**
 * Loại bỏ header `Mcp-Session-Id` khỏi một header set (so khớp
 * không phân biệt hoa thường — HTTP header không phân biệt case).
 * Trả về object mới, không mutate input. Dùng cho mọi request
 * stateless: kể cả khi một lớp dưới đã thêm session id (vd server
 * trả `mcp-session-id` trong response trước đó), header vẫn bị
 * loại trước khi request rời khỏi client.
 */
export function stripSessionIdHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'mcp-session-id') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Header cho một request stateless: base headers (Authorization,
 * Content-Type, ...) cộng đảm bảo không có `Mcp-Session-Id`.
 * Header session do caller vô tình truyền vào cũng bị loại —
 * stateless client không bao giờ gửi nó, dù caller có đưa.
 */
export function buildStatelessHeaders(
  baseHeaders?: Record<string, string>,
): Record<string, string> {
  return stripSessionIdHeader(baseHeaders);
}

/**
 * True khi một header set không chứa `Mcp-Session-Id`
 * (kiểm tra dùng trong test + assert nội bộ trước khi gửi).
 */
export function hasNoSessionIdHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return true;
  return !Object.keys(headers).some((k) => k.toLowerCase() === 'mcp-session-id');
}

/** Kết quả `connect()` — negotiation + discovery đã cache. */
export interface StatelessConnectResult {
  /** Đường kết nối thực tế đã thương lượng. */
  mode: StatelessNegotiatedMode;
  /** Protocol version đang có hiệu lực. */
  protocolVersion: string;
  /** Discovery document (null khi server pre-2.0 / không trả). */
  discovered: ServerDiscoverResult | null;
  /** True khi `'auto'` đã fallback về handshake. */
  fellBack: boolean;
  /** Toàn bộ bản ghi negotiation (để log / UI). */
  negotiation: StatelessNegotiation;
}

/**
 * Stateless MCP client hoàn chỉnh.
 *
 * Vòng đời: `new StatelessMcpClient(transport, options)` →
 * `await connect()` (discover + negotiation) → `call()` /
 * `callTool()` / `discover()` / `callTask()` → `close()`.
 * Gọi `call*` trước `connect()` ném `StatelessClientError` rõ
 * ràng thay vì gửi request mù.
 */
export class StatelessMcpClient {
  private readonly transport: StatelessFullTransport;
  private readonly options: Required<
    Pick<StatelessClientOptions, 'mode' | 'protocolVersion' | 'discoverTimeoutMs'>
  > &
    Pick<StatelessClientOptions, 'capabilities' | 'clientInfo'>;
  private state: StatelessClientState = 'idle';
  private negotiation: StatelessNegotiation | null = null;
  private discovered: ServerDiscoverResult | null = null;
  private protocolVersion: string;

  constructor(transport: StatelessFullTransport, options: StatelessClientOptions = {}) {
    this.transport = transport;
    this.options = {
      mode: options.mode ?? 'auto',
      protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026,
      discoverTimeoutMs: options.discoverTimeoutMs ?? 10_000,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
    };
    this.protocolVersion = this.options.protocolVersion;
  }

  /** Trạng thái hiện tại. */
  get currentState(): StatelessClientState {
    return this.state;
  }

  /** True khi client đang nói stateless (không handshake, không session). */
  get isStateless(): boolean {
    return this.negotiation?.mode === 'stateless';
  }

  /** True khi client đã fallback về handshake với server cũ. */
  get isHandshakeFallback(): boolean {
    return this.negotiation?.fellBack === true;
  }

  /** Protocol version đang có hiệu lực (sau negotiation). */
  get negotiatedProtocolVersion(): string {
    return this.protocolVersion;
  }

  /** Discovery document đã cache (null khi chưa connect / server không trả). */
  get discovery(): ServerDiscoverResult | null {
    return this.discovered;
  }

  /** Bản ghi negotiation đầy đủ (null khi chưa connect). */
  get lastNegotiation(): StatelessNegotiation | null {
    return this.negotiation;
  }

  /**
   * Kết nối: chạy negotiation (`server/discover` trước, fallback
   * handshake theo mode). Discovery document được cache để
   * `call()` kiểm tra capability trước khi gọi. Lỗi negotiation
   * (cả discover lẫn handshake đều fail) ném
   * `StatelessClientError` và client ở lại trạng thái `idle`.
   */
  async connect(): Promise<StatelessConnectResult> {
    if (this.state === 'closed') {
      throw new StatelessClientError('StatelessMcpClient đã đóng — không connect lại được.', 'closed');
    }
    if (this.state === 'connected' && this.negotiation) {
      return this.toConnectResult();
    }
    const negotiable = {
      discover: async (): Promise<ServerDiscoverResult | null> => {
        if (typeof this.transport.discover === 'function') {
          return this.withTimeout(
            this.transport.discover(),
            this.options.discoverTimeoutMs,
            'server/discover hết thời gian chờ',
          );
        }
        return this.withTimeout(
          discoverServer(this.transport, {
            protocolVersion: this.options.protocolVersion,
            ...(this.options.capabilities ? { capabilities: this.options.capabilities } : {}),
            ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
          }),
          this.options.discoverTimeoutMs,
          'server/discover hết thời gian chờ',
        );
      },
      initialize: async (): Promise<{ protocolVersion?: string }> => {
        if (typeof this.transport.initialize !== 'function') {
          throw new StatelessClientError(
            'Transport không hỗ trợ initialize — không fallback được về server MCP cũ.',
            'no-initialize',
          );
        }
        return this.transport.initialize();
      },
    };
    let negotiation: StatelessNegotiation;
    try {
      negotiation = await negotiateStatelessConnection(negotiable, this.options.mode, {
        fallbackVersion: this.options.protocolVersion,
      });
    } catch (err) {
      throw new StatelessClientError(
        `StatelessMcpClient: thương lượng kết nối thất bại: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'negotiation-failed',
      );
    }
    this.negotiation = negotiation;
    this.discovered = negotiation.discovered;
    this.protocolVersion = negotiation.protocolVersion;
    this.state = 'connected';
    return this.toConnectResult();
  }

  /**
   * Khám phá lại capability của server (`server/discover`) và cập
   * nhật cache. Không cần handshake trước — request tự mang `_meta`.
   * Ưu tiên `transport.discover()` khi có (client thật đã nối sẵn
   * logic discover của nó); nếu không thì gọi `server/discover` qua
   * JSON-RPC thô. Trả null khi server không biết method (pre-2.0).
   */
  async discover(): Promise<ServerDiscoverResult | null> {
    this.requireConnected();
    let result: ServerDiscoverResult | null;
    if (typeof this.transport.discover === 'function') {
      result = await this.withTimeout(
        this.transport.discover(),
        this.options.discoverTimeoutMs,
        'server/discover hết thời gian chờ',
      );
    } else {
      result = await discoverServer(this.transport, {
        protocolVersion: this.protocolVersion,
        ...(this.options.capabilities ? { capabilities: this.options.capabilities } : {}),
        ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
      });
    }
    if (result) {
      this.discovered = result;
      this.protocolVersion = negotiateStatelessVersion(
        result.protocolVersion,
        result.supportedVersions,
        this.protocolVersion,
      );
    }
    return result;
  }

  /**
   * Một request tự mang `_meta` (stateless) — hoặc request thường
   * khi đang ở handshake fallback mode. Ở stateless mode, params
   * được gắn `_meta` (protocol version + capabilities + clientInfo
   * + roundTrip/task continuation khi có); ở handshake mode thì
   * params đi nguyên như client 2025-11-25.
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
    callOptions: {
      roundTrip?: StatelessRequestMeta['roundTrip'];
      task?: StatelessRequestMeta['task'];
    } = {},
  ): Promise<unknown> {
    this.requireConnected();
    if (typeof method !== 'string' || method.length === 0) {
      throw new StatelessClientError('StatelessMcpClient.call cần method là chuỗi không rỗng.', 'bad-method');
    }
    if (this.isStateless) {
      return requestStateless(this.transport, method, params, {
        protocolVersion: this.protocolVersion,
        ...(this.options.capabilities ? { capabilities: this.options.capabilities } : {}),
        ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
        ...(callOptions.roundTrip ? { roundTrip: callOptions.roundTrip } : {}),
        ...(callOptions.task ? { task: callOptions.task } : {}),
      });
    }
    return this.transport.requestJsonRpc(method, params);
  }

  /**
   * Gọi một tool (`tools/call`) qua client stateless. Kiểm tra
   * trước bằng discovery cache: server không khai capability
   * `tools` thì ném lỗi rõ ràng thay vì chờ -32601.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    callOptions: {
      roundTrip?: StatelessRequestMeta['roundTrip'];
      task?: StatelessRequestMeta['task'];
    } = {},
  ): Promise<unknown> {
    this.requireConnected();
    if (typeof name !== 'string' || name.length === 0) {
      throw new StatelessClientError('StatelessMcpClient.callTool cần tên tool không rỗng.', 'bad-tool');
    }
    this.requireCapability('tools', 'tools/call');
    return this.call('tools/call', { name, arguments: args }, callOptions);
  }

  /**
   * Gọi một method thuộc Tasks extension (`tasks/get` /
   * `tasks/update` / `tasks/cancel`). Kiểm tra discovery cache:
   * server không khai tasks thì ném lỗi rõ ràng.
   */
  async callTaskMethod(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireConnected();
    this.requireCapability('tasks', method);
    return this.call(method, params);
  }

  /** Liệt kê tool của server (`tools/list`), kiểm tra capability trước. */
  async listTools(params?: Record<string, unknown>): Promise<unknown> {
    this.requireConnected();
    this.requireCapability('tools', 'tools/list');
    return this.call('tools/list', params);
  }

  /** Liệt kê resource của server (`resources/list`), kiểm tra capability trước. */
  async listResources(params?: Record<string, unknown>): Promise<unknown> {
    this.requireConnected();
    this.requireCapability('resources', 'resources/list');
    return this.call('resources/list', params);
  }

  /** Liệt kê prompt của server (`prompts/list`), kiểm tra capability trước. */
  async listPrompts(params?: Record<string, unknown>): Promise<unknown> {
    this.requireConnected();
    this.requireCapability('prompts', 'prompts/list');
    return this.call('prompts/list', params);
  }

  /**
   * Build `_meta` cho một request (dùng khi coordinator tự gửi
   * qua transport khác mà vẫn muốn đúng envelope stateless).
   */
  buildMeta(callOptions: {
    roundTrip?: StatelessRequestMeta['roundTrip'];
    task?: StatelessRequestMeta['task'];
  } = {}): StatelessRequestMeta {
    return buildStatelessMeta({
      protocolVersion: this.protocolVersion,
      ...(this.options.capabilities ? { capabilities: this.options.capabilities } : {}),
      ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
      ...(callOptions.roundTrip ? { roundTrip: callOptions.roundTrip } : {}),
      ...(callOptions.task ? { task: callOptions.task } : {}),
    });
  }

  /** Gắn `_meta` stateless vào params (copy, không mutate input). */
  withMeta(
    params: Record<string, unknown> | undefined,
    callOptions: {
      roundTrip?: StatelessRequestMeta['roundTrip'];
      task?: StatelessRequestMeta['task'];
    } = {},
  ): Record<string, unknown> {
    return withStatelessMeta(params, this.buildMeta(callOptions));
  }

  /** Đóng client (đóng transport khi có). Gọi nhiều lần vẫn an toàn. */
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (typeof this.transport.close === 'function') {
      await this.transport.close();
    }
  }

  /** Một dòng mô tả trạng thái kết nối (log / activity feed). */
  describe(): string {
    if (this.state === 'idle') return 'StatelessMcpClient chưa kết nối.';
    if (this.state === 'closed') return 'StatelessMcpClient đã đóng.';
    if (this.negotiation?.fellBack) {
      return `MCP handshake fallback (server ${this.protocolVersion}, pre-2.0 — không session stateless).`;
    }
    if (this.discovered) {
      return (
        `MCP stateless ${this.protocolVersion} — server "${this.discovered.serverInfo.name} ` +
        `${this.discovered.serverInfo.version}" (discover OK, không handshake, không Mcp-Session-Id).`
      );
    }
    return `MCP stateless ${this.protocolVersion} (không discovery document, không handshake).`;
  }

  private toConnectResult(): StatelessConnectResult {
    const negotiation = this.negotiation as StatelessNegotiation;
    return {
      mode: negotiation.mode,
      protocolVersion: negotiation.protocolVersion,
      discovered: negotiation.discovered,
      fellBack: negotiation.fellBack,
      negotiation,
    };
  }

  private requireConnected(): void {
    if (this.state === 'closed') {
      throw new StatelessClientError('StatelessMcpClient đã đóng.', 'closed');
    }
    if (this.state !== 'connected' || !this.negotiation) {
      throw new StatelessClientError(
        'StatelessMcpClient chưa connect() — gọi connect() trước khi gọi method.',
        'not-connected',
      );
    }
  }

  /**
   * Kiểm tra capability từ discovery cache. Không có discovery
   * document (server pre-2.0 hoặc không trả) thì cho qua — server
   * cũ vẫn có thể hỗ trợ method mà không khai trong discover.
   * Có document mà thiếu capability thì lỗi rõ ràng.
   */
  private requireCapability(
    capability: 'tools' | 'resources' | 'prompts' | 'tasks' | 'apps',
    method: string,
  ): void {
    if (!this.discovered) return;
    if (this.discovered.capabilities[capability] === undefined) {
      throw new StatelessClientError(
        `Server không khai capability "${capability}" trong server/discover — không gọi "${method}".`,
        'capability-missing',
      );
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new StatelessClientError(message, 'timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Adapter: biến một `StatelessMcpClient` thành transport tối thiểu
 * cho MRTR driver / TaskHandle (`requestJsonRpc` + `request`).
 * Dùng khi các module khác (mrtr.ts, tasks.ts) cần gọi qua client
 * stateless mà không biết class này.
 */
export function statelessClientAsTransport(client: StatelessMcpClient): {
  requestJsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
} {
  return {
    requestJsonRpc: (method, params) => client.call(method, params),
    request: (method, params) => client.call(method, params),
  };
}

/**
 * Parse kết quả `server/discover` thô thành `ServerDiscoverResult`
 * đã validate (re-export tiện ích từ stateless.ts để coordinator
 * chỉ cần import từ module này).
 */
export function parseDiscoverResult(value: unknown): ServerDiscoverResult {
  return parseServerDiscoverResult(value);
}

