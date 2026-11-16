/**
 * MCP Apps host v13 — dialect JSON-RPC `ui/` qua postMessage (SEP-1865, ideas only).
 *
 * App trong sandboxed iframe và host nói chuyện bằng JSON-RPC 2.0
 * trên postMessage, với method mang tiền tố `ui/` (cùng một control
 * path với `tools/call` — mọi action từ UI đều đi qua host, app
 * không bao giờ tự gọi tool hay tự mở link):
 *
 *   App -> host (request, có `id`, host phải trả response):
 *   - `ui/initialize` — bắt tay đầu phiên: app gửi `clientInfo`
 *     (tên app + version + capabilities nó hỗ trợ); host trả
 *     `HostContext` (theme, locale, timezone, platform, display
 *     mode, kích thước container) + protocol version + session id.
 *     Mọi method khác trước `ui/initialize` đều bị từ chối
 *     (-32002, chưa khởi tạo).
 *   - `ui/update-model-context` — app báo model context mới (dữ liệu
 *     app đang hiển thị / trạng thái task); host lưu + callback cho
 *     UI cập nhật, trả `{ ok, appliedKeys }`.
 *   - `ui/message` — app gửi message hiển thị/log về host (level:
 *     info/warn/error), host quyết định hiện toast hay chỉ ghi log.
 *   - `ui/open-link` — app xin mở link ngoài: chỉ http(s), host
 *     quyết định mở hay chặn (mặc định chặn), trả `{ ok, opened }`.
 *   - `tools/call` — app xin gọi tool qua host: host kiểm tra
 *     allowlist tool của session, thực thi qua callback, trả kết quả
 *     (hoặc lỗi JSON-RPC) — đây là ĐƯỜNG DUY NHẤT app gọi tool.
 *   - `ui/close` — app xin đóng chính nó (host extension).
 *   - `ui/set-display-mode` — app xin đổi display mode (host
 *     extension, host vẫn là người quyết định cuối).
 *
 *   Host -> app (notification, không có `id`):
 *   - `ui/model-context-updated` — host đẩy model context mới xuống
 *     (vd task chạy xong, dữ liệu live đổi).
 *   - `ui/message` — host gửi message xuống app (vd thông báo).
 *   - `ui/display-mode-changed` — host báo display mode đã đổi.
 *
 * Lỗi JSON-RPC chuẩn: -32700 parse error, -32600 invalid request,
 * -32601 method not found, -32602 invalid params, -32002 chưa khởi
 * tạo, -32003 tool không được phép / link bị chặn, -32603 lỗi nội bộ.
 *
 * Module này thuần (không DOM): renderer chỉ việc `postMessage`
 * object mà host build ra, và đưa `event.data` vào đây. Nhờ vậy toàn
 * bộ dialect test được bằng node:test. Song song với bridge legacy
 * `app-*` trong `appsBridge.ts` (vẫn giữ cho app cũ) — renderer nhận
 * diện bằng `jsonrpc === '2.0'` để đưa vào dialect này.
 */

export const UI_DIALECT_PROTOCOL_VERSION = 'ui/1.0';
export const UI_DIALECT_METHODS = [
  'ui/initialize',
  'ui/update-model-context',
  'ui/message',
  'ui/open-link',
  'tools/call',
  'ui/close',
  'ui/set-display-mode',
] as const;
export type UiDialectMethod = (typeof UI_DIALECT_METHODS)[number];

/** Notification host -> app. */
export const UI_DIALECT_HOST_NOTIFICATIONS = [
  'ui/model-context-updated',
  'ui/message',
  'ui/display-mode-changed',
] as const;
export type UiDialectHostNotification = (typeof UI_DIALECT_HOST_NOTIFICATIONS)[number];

/** Mã lỗi JSON-RPC của dialect. */
export const UI_JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  notInitialized: -32002,
  forbidden: -32003,
  internalError: -32603,
} as const;

export class UiDialectError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'UiDialectError';
    this.code = code;
  }
}

/** Kiểu id JSON-RPC (string/number; null = response cho notification lỗi). */
export type JsonRpcId = string | number | null;

/** Một JSON-RPC request/notification thô. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown> | unknown[];
  id?: JsonRpcId;
}

/** Một JSON-RPC response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Host context host gửi cho app trong `ui/initialize`. */
export interface UiHostContext {
  /** Theme hiện tại của host: light / dark / system. */
  theme: 'light' | 'dark' | 'system';
  /** Locale của UI host, vd `vi`, `en`. */
  locale: string;
  /** Timezone IANA, vd `Asia/Ho_Chi_Minh`. */
  timezone: string;
  /** Platform host đang chạy. */
  platform: 'win32' | 'darwin' | 'linux';
  /** Display mode app đang hiển thị. */
  displayMode: 'inline' | 'fullscreen' | 'pip';
  /** Kích thước container chứa app (px). */
  container: { width: number; height: number };
  /** Version của host (open-bot). */
  hostVersion: string;
  /** Tên host (hiển thị cho app). */
  hostName: string;
  /** Capability host hỗ trợ (vd `tools-call`, `open-link`, `pip`). */
  capabilities: string[];
}

/** Model context app gửi / host đẩy (mở — app nào cũng có thêm field riêng). */
export interface UiModelContext {
  /** Model đang chạy (nếu app biết). */
  model?: string;
  /** Trạng thái task gắn với app: working/completed/failed/input_required/cancelled. */
  taskStatus?: string;
  /** Tiến độ 0..100 (khi taskStatus là working). */
  progress?: number;
  /** Dữ liệu app đang hiển thị (JSON thuần, host chỉ lưu + forward). */
  data?: Record<string, unknown>;
  /** Field mở rộng của app. */
  [key: string]: unknown;
}

/** Thông tin client app gửi trong `ui/initialize`. */
export interface UiClientInfo {
  name?: string;
  version?: string;
  /** Capability app hỗ trợ (vd `display-mode-pip`). */
  capabilities?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function paramsAsRecord(params: unknown): Record<string, unknown> | null {
  if (params === undefined) return {};
  if (isRecord(params)) return params;
  return null;
}

/**
 * Parse một message JSON-RPC thô (đã là object). Trả null khi không
 * phải JSON-RPC 2.0 hợp lệ (thiếu `jsonrpc: '2.0'`, thiếu method,
 * id sai kiểu). Batch (array) được tách ở `UiDialectHost` — hàm này
 * chỉ parse một message đơn.
 */
export function parseUiJsonRpcMessage(data: unknown): JsonRpcRequest | null {
  if (!isRecord(data)) return null;
  if (data['jsonrpc'] !== '2.0') return null;
  const method = data['method'];
  if (typeof method !== 'string' || method === '') return null;
  const id = data['id'];
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== 'string' &&
    typeof id !== 'number'
  ) {
    return null;
  }
  return {
    jsonrpc: '2.0',
    method,
    ...(data['params'] !== undefined ? { params: data['params'] as JsonRpcRequest['params'] } : {}),
    ...(id !== undefined ? { id: id as JsonRpcId } : {}),
  };
}

/** True khi message là JSON-RPC 2.0 (để renderer phân biệt với bridge legacy `app-*`). */
export function isUiJsonRpcMessage(data: unknown): boolean {
  return parseUiJsonRpcMessage(data) !== null;
}

/** Build một JSON-RPC response thành công. */
export function uiJsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build một JSON-RPC response lỗi. */
export function uiJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** Build một JSON-RPC notification host -> app. */
export function uiJsonRpcNotification(
  method: UiDialectHostNotification,
  params: Record<string, unknown>,
): JsonRpcRequest {
  return { jsonrpc: '2.0', method, params };
}

/** Kết quả `ui/initialize` host trả cho app. */
export interface UiInitializeResult {
  protocolVersion: string;
  sessionId: string;
  hostContext: UiHostContext;
  /** Capability host hỗ trợ. */
  capabilities: string[];
}

/** Tuỳ chọn cho một session dialect. */
export interface UiDialectSessionOptions {
  /** App URI (vd `ui://server/app`). */
  appUri: string;
  /** Host context gửi cho app khi initialize. */
  hostContext: UiHostContext;
  /** Tool app được phép gọi qua `tools/call` (rỗng = không được gọi tool nào). */
  allowedTools?: readonly string[];
  /** App có được mở link ngoài không (mặc định: không — host chặn). */
  allowOpenLink?: boolean;
  /** Timeout chờ host thực thi `tools/call` (ms). */
  toolCallTimeoutMs?: number;
}

/** Callback host thực thi `tools/call` cho app (trả kết quả JSON thuần). */
export type UiToolsCallHandler = (
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Callback host quyết định mở link (trả true = mở). */
export type UiOpenLinkHandler = (sessionId: string, url: string) => boolean | Promise<boolean>;

/** Snapshot một session dialect. */
export interface UiDialectSessionSnapshot {
  sessionId: string;
  appUri: string;
  initialized: boolean;
  clientInfo?: UiClientInfo;
  displayMode: UiHostContext['displayMode'];
  modelContext: UiModelContext;
  messagesIn: number;
  messagesOut: number;
  errors: number;
  createdAtMs: number;
  lastMessageAtMs: number;
}

/** Tuỳ chọn cho UiDialectHost. */
export interface UiDialectHostOptions {
  now?: () => number;
  maxSessions?: number;
  maxLogEntries?: number;
  /** Host thực thi tools/call. */
  onToolsCall?: UiToolsCallHandler;
  /** Host quyết định mở link. */
  onOpenLink?: UiOpenLinkHandler;
  /** App gửi message (ui/message) về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** App cập nhật model context. */
  onModelContext?: (sessionId: string, context: UiModelContext) => void;
  /** App xin đóng. */
  onCloseRequest?: (sessionId: string) => void;
  /** App xin đổi display mode. */
  onDisplayModeChange?: (sessionId: string, mode: UiHostContext['displayMode']) => void;
}

/** Entry audit log của dialect host. */
export interface UiDialectLogEntry {
  seq: number;
  atMs: number;
  sessionId: string;
  method: string;
  outcome: string;
}

interface SessionState extends UiDialectSessionOptions {
  sessionId: string;
  initialized: boolean;
  clientInfo?: UiClientInfo;
  displayMode: UiHostContext['displayMode'];
  modelContext: UiModelContext;
  messagesIn: number;
  messagesOut: number;
  errors: number;
  createdAtMs: number;
  lastMessageAtMs: number;
}

/** Tối đa session dialect cùng lúc. */
export const UI_DIALECT_MAX_SESSIONS = 16;
/** Timeout mặc định cho tools/call qua dialect (ms). */
export const UI_DIALECT_DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Host-side dispatcher cho dialect JSON-RPC `ui/` của MCP Apps.
 * Một instance cho toàn bộ desktop; renderer tạo session mỗi khi mở
 * app và đưa `event.data` vào `handleMessage`.
 */
export class UiDialectHost {
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxLogEntries: number;
  private readonly onToolsCall?: UiToolsCallHandler;
  private readonly onOpenLink?: UiOpenLinkHandler;
  private readonly onMessage?: UiDialectHostOptions['onMessage'];
  private readonly onModelContext?: UiDialectHostOptions['onModelContext'];
  private readonly onCloseRequest?: UiDialectHostOptions['onCloseRequest'];
  private readonly onDisplayModeChange?: UiDialectHostOptions['onDisplayModeChange'];
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: UiDialectLogEntry[] = [];
  private seq = 0;
  private sessionCounter = 0;

  constructor(options: UiDialectHostOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = Math.max(1, options.maxSessions ?? UI_DIALECT_MAX_SESSIONS);
    this.maxLogEntries = Math.max(10, options.maxLogEntries ?? 500);
    this.onToolsCall = options.onToolsCall;
    this.onOpenLink = options.onOpenLink;
    this.onMessage = options.onMessage;
    this.onModelContext = options.onModelContext;
    this.onCloseRequest = options.onCloseRequest;
    this.onDisplayModeChange = options.onDisplayModeChange;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Tạo session dialect cho một app vừa mở. Trả sessionId. */
  createSession(options: UiDialectSessionOptions): string {
    if (this.sessions.size >= this.maxSessions) {
      throw new UiDialectError(
        `MCP Apps dialect: đã mở tối đa ${this.maxSessions} app cùng lúc.`,
        UI_JSONRPC_ERROR_CODES.internalError,
      );
    }
    this.sessionCounter += 1;
    const sessionId = `ui-${this.now()}-${this.sessionCounter}`;
    const state: SessionState = {
      ...options,
      sessionId,
      initialized: false,
      displayMode: options.hostContext.displayMode,
      modelContext: {},
      messagesIn: 0,
      messagesOut: 0,
      errors: 0,
      createdAtMs: this.now(),
      lastMessageAtMs: this.now(),
      allowedTools: options.allowedTools ?? [],
      toolCallTimeoutMs: options.toolCallTimeoutMs ?? UI_DIALECT_DEFAULT_TOOL_TIMEOUT_MS,
    };
    this.sessions.set(sessionId, state);
    this.pushLog(sessionId, 'session-create', 'accepted');
    return sessionId;
  }

  /** Đóng session dialect (app đã đóng / bị đuổi). */
  closeSession(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    if (removed) this.pushLog(sessionId, 'session-close', 'accepted');
    return removed;
  }

  /** Snapshot một session (không lộ callback/handler). */
  getSession(sessionId: string): UiDialectSessionSnapshot | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      appUri: s.appUri,
      initialized: s.initialized,
      ...(s.clientInfo ? { clientInfo: { ...s.clientInfo } } : {}),
      displayMode: s.displayMode,
      modelContext: { ...s.modelContext },
      messagesIn: s.messagesIn,
      messagesOut: s.messagesOut,
      errors: s.errors,
      createdAtMs: s.createdAtMs,
      lastMessageAtMs: s.lastMessageAtMs,
    };
  }

  listSessions(): UiDialectSessionSnapshot[] {
    return [...this.sessions.keys()]
      .map((id) => this.getSession(id)!)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** Cập nhật host context của session (vd theme/locale đổi) — dùng cho lần initialize sau. */
  updateHostContext(sessionId: string, patch: Partial<UiHostContext>): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.hostContext = { ...s.hostContext, ...patch };
    if (patch.displayMode) s.displayMode = patch.displayMode;
    return true;
  }

  /**
   * Xử lý một message JSON-RPC từ app. Chấp nhận cả message đơn lẫn
   * batch (array). Trả response (hoặc mảng response cho batch), hoặc
   * null khi message chỉ là notification (không có `id`) hoặc đã bị
   * drop hoàn toàn. `tools/call` là async — caller phải await.
   */
  async handleMessage(
    sessionId: string,
    data: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return uiJsonRpcError(null, UI_JSONRPC_ERROR_CODES.invalidRequest, 'Batch JSON-RPC rỗng.');
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of data) {
        const res = await this.handleSingle(session, item);
        if (res) responses.push(res);
      }
      return responses.length > 0 ? responses : null;
    }
    return this.handleSingle(session, data);
  }

  private async handleSingle(
    session: SessionState,
    data: unknown,
  ): Promise<JsonRpcResponse | null> {
    const parsed = parseUiJsonRpcMessage(data);
    if (!parsed) {
      session.errors += 1;
      this.pushLog(session.sessionId, 'unknown', 'parse-error');
      // Không có id hợp lệ để trả → trả response id null (JSON-RPC cho phép).
      return uiJsonRpcError(null, UI_JSONRPC_ERROR_CODES.parseError, 'Message không phải JSON-RPC 2.0 hợp lệ.');
    }
    const isNotification = parsed.id === undefined;
    session.messagesIn += 1;
    session.lastMessageAtMs = this.now();
    const method = parsed.method;

    // Method không rõ → -32601 (trừ notification thì drop lặng).
    if (!(UI_DIALECT_METHODS as readonly string[]).includes(method)) {
      session.errors += 1;
      this.pushLog(session.sessionId, method, 'method-not-found');
      if (isNotification) return null;
      return uiJsonRpcError(
        parsed.id ?? null,
        UI_JSONRPC_ERROR_CODES.methodNotFound,
        `Method "${method}" is not supported by the host.`,
      );
    }

    // Chưa initialize thì chỉ ui/initialize được phép.
    if (!session.initialized && method !== 'ui/initialize') {
      session.errors += 1;
      this.pushLog(session.sessionId, method, 'not-initialized');
      if (isNotification) return null;
      return uiJsonRpcError(
        parsed.id ?? null,
        UI_JSONRPC_ERROR_CODES.notInitialized,
        'App must call ui/initialize before using other methods.',
      );
    }

    const params = paramsAsRecord(parsed.params);
    if (params === null) {
      session.errors += 1;
      this.pushLog(session.sessionId, method, 'invalid-params');
      if (isNotification) return null;
      return uiJsonRpcError(
        parsed.id ?? null,
        UI_JSONRPC_ERROR_CODES.invalidParams,
        'Params của method phải là object.',
      );
    }

    try {
      const result = await this.dispatch(session, method as UiDialectMethod, params);
      session.messagesOut += 1;
      this.pushLog(session.sessionId, method, 'accepted');
      if (isNotification) return null;
      return uiJsonRpcResult(parsed.id ?? null, result);
    } catch (err) {
      session.errors += 1;
      this.pushLog(session.sessionId, method, 'error');
      if (isNotification) return null;
      if (err instanceof UiDialectError) {
        return uiJsonRpcError(parsed.id ?? null, err.code, err.message);
      }
      return uiJsonRpcError(
        parsed.id ?? null,
        UI_JSONRPC_ERROR_CODES.internalError,
        `Lỗi nội bộ khi xử lý "${method}": ${(err as Error).message}`,
      );
    }
  }

  private async dispatch(
    session: SessionState,
    method: UiDialectMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'ui/initialize': {
        const clientInfoRaw = params['clientInfo'];
        const clientInfo: UiClientInfo = isRecord(clientInfoRaw)
          ? {
              ...(asNonEmptyString(clientInfoRaw['name']) ? { name: clientInfoRaw['name'] as string } : {}),
              ...(asNonEmptyString(clientInfoRaw['version']) ? { version: clientInfoRaw['version'] as string } : {}),
              ...(Array.isArray(clientInfoRaw['capabilities'])
                ? { capabilities: (clientInfoRaw['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string') }
                : {}),
            }
          : {};
        session.clientInfo = clientInfo;
        session.initialized = true;
        const result: UiInitializeResult = {
          protocolVersion: UI_DIALECT_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          hostContext: { ...session.hostContext },
          capabilities: [...session.hostContext.capabilities],
        };
        return result;
      }
      case 'ui/update-model-context': {
        const contextRaw = params['context'];
        if (!isRecord(contextRaw)) {
          throw new UiDialectError(
            'ui/update-model-context requires params.context to be an object.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        const progress = contextRaw['progress'];
        if (
          progress !== undefined &&
          (typeof progress !== 'number' || progress < 0 || progress > 100)
        ) {
          throw new UiDialectError(
            'Model context: progress phải nằm trong 0..100.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        session.modelContext = { ...session.modelContext, ...contextRaw };
        this.onModelContext?.(session.sessionId, { ...session.modelContext });
        return { ok: true, appliedKeys: Object.keys(contextRaw) };
      }
      case 'ui/message': {
        const message = asNonEmptyString(params['message']);
        if (message === undefined) {
          throw new UiDialectError(
            'ui/message requires params.message to be a non-empty string.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        const levelRaw = params['level'];
        const level: 'info' | 'warn' | 'error' =
          levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info';
        this.onMessage?.(session.sessionId, message, level);
        return { ok: true };
      }
      case 'ui/open-link': {
        const url = asNonEmptyString(params['url']);
        if (url === undefined || !/^https?:\/\//i.test(url)) {
          throw new UiDialectError(
            'ui/open-link requires params.url to be a valid http(s) URL.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        if (!session.allowOpenLink) {
          throw new UiDialectError(
            `Link "${url}" bị chặn: app này không được phép mở link ngoài.`,
            UI_JSONRPC_ERROR_CODES.forbidden,
          );
        }
        const opened = this.onOpenLink ? await this.onOpenLink(session.sessionId, url) : false;
        if (!opened) {
          throw new UiDialectError(
            `Link "${url}" was blocked by the host.`,
            UI_JSONRPC_ERROR_CODES.forbidden,
          );
        }
        return { ok: true, opened: true, url };
      }
      case 'tools/call': {
        const toolName = asNonEmptyString(params['name']) ?? asNonEmptyString(params['tool']);
        if (toolName === undefined) {
          throw new UiDialectError(
            'tools/call requires params.name to be a tool name.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        if (!(session.allowedTools ?? []).includes(toolName)) {
          throw new UiDialectError(
            `Tool "${toolName}" is not allowed to be called from this app.`,
            UI_JSONRPC_ERROR_CODES.forbidden,
          );
        }
        const argsRaw = params['arguments'];
        const args = isRecord(argsRaw) ? argsRaw : {};
        if (!this.onToolsCall) {
          throw new UiDialectError(
            'Host chưa cấu hình handler cho tools/call.',
            UI_JSONRPC_ERROR_CODES.internalError,
          );
        }
        const result = await this.withTimeout(
          Promise.resolve(this.onToolsCall(session.sessionId, toolName, args)),
          session.toolCallTimeoutMs ?? UI_DIALECT_DEFAULT_TOOL_TIMEOUT_MS,
          `Tool "${toolName}" chạy quá thời gian cho phép.`,
        );
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }], isError: false };
      }
      case 'ui/close': {
        this.onCloseRequest?.(session.sessionId);
        return { ok: true };
      }
      case 'ui/set-display-mode': {
        const mode = params['mode'];
        if (
          typeof mode !== 'string' ||
          !(['inline', 'fullscreen', 'pip'] as const).includes(mode as 'inline' | 'fullscreen' | 'pip')
        ) {
          throw new UiDialectError(
            'ui/set-display-mode cần params.mode là inline, fullscreen hoặc pip.',
            UI_JSONRPC_ERROR_CODES.invalidParams,
          );
        }
        session.displayMode = mode as UiHostContext['displayMode'];
        this.onDisplayModeChange?.(session.sessionId, session.displayMode);
        return { ok: true, displayMode: session.displayMode };
      }
      default:
        throw new UiDialectError(
          `Method "${method}" không được hỗ trợ.`,
          UI_JSONRPC_ERROR_CODES.methodNotFound,
        );
    }
  }

  /**
   * Build notification host -> app: đẩy model context mới xuống app
   * (vd task chạy xong). Renderer postMessage object này vào iframe.
   */
  buildModelContextNotification(sessionId: string, context: UiModelContext): JsonRpcRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.modelContext = { ...session.modelContext, ...context };
    session.messagesOut += 1;
    return uiJsonRpcNotification('ui/model-context-updated', { context: { ...session.modelContext } });
  }

  /** Build notification host -> app: gửi message xuống app. */
  buildMessageNotification(
    sessionId: string,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): JsonRpcRequest | null {
    if (!this.sessions.has(sessionId)) return null;
    const session = this.sessions.get(sessionId)!;
    session.messagesOut += 1;
    return uiJsonRpcNotification('ui/message', { message, level });
  }

  /** Build notification host -> app: báo display mode đã đổi. */
  buildDisplayModeNotification(
    sessionId: string,
    mode: UiHostContext['displayMode'],
  ): JsonRpcRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.displayMode = mode;
    session.messagesOut += 1;
    return uiJsonRpcNotification('ui/display-mode-changed', { displayMode: mode });
  }

  /** Audit log (mới nhất cuối). */
  getLog(): UiDialectLogEntry[] {
    return [...this.log];
  }

  getLogForSession(sessionId: string): UiDialectLogEntry[] {
    return this.log.filter((e) => e.sessionId === sessionId);
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UiDialectError(message, UI_JSONRPC_ERROR_CODES.internalError)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pushLog(sessionId: string, method: string, outcome: string): void {
    this.seq += 1;
    this.log.push({ seq: this.seq, atMs: this.now(), sessionId, method, outcome });
    while (this.log.length > this.maxLogEntries) this.log.shift();
  }
}

/** Build kết quả `ui/initialize` cho một session (dùng trong test + host tự build khi cần). */
export function buildUiInitializeResult(sessionId: string, hostContext: UiHostContext): UiInitializeResult {
  return {
    protocolVersion: UI_DIALECT_PROTOCOL_VERSION,
    sessionId,
    hostContext: { ...hostContext, container: { ...hostContext.container } },
    capabilities: [...hostContext.capabilities],
  };
}

/**
 * Build một `UiHostContext` mặc định từ môi trường host. Renderer
 * gọi hàm này (hoặc tự build) rồi đưa vào session; các field chưa
 * biết thì dùng giá trị mặc định an toàn.
 */
export function buildDefaultHostContext(
  overrides: Partial<UiHostContext> & { container?: { width: number; height: number } } = {},
): UiHostContext {
  const platform =
    typeof process !== 'undefined' && typeof process.platform === 'string'
      ? (process.platform as UiHostContext['platform'])
      : 'linux';
  return {
    theme: overrides.theme ?? 'system',
    locale: overrides.locale ?? 'en',
    timezone: overrides.timezone ?? 'UTC',
    platform: ['win32', 'darwin', 'linux'].includes(platform) ? platform : 'linux',
    displayMode: overrides.displayMode ?? 'inline',
    container: overrides.container ?? { width: 720, height: 480 },
    hostVersion: overrides.hostVersion ?? '0.2.0',
    hostName: overrides.hostName ?? 'open-bot',
    capabilities: overrides.capabilities ?? ['tools-call', 'open-link', 'model-context', 'pip', 'fullscreen'],
  };
}
