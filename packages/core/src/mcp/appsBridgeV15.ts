/**
 * MCP Apps bridge v15 — cầu postMessage JSON-RPC 2.0 giữa app trong
 * sandboxed iframe và host (SEP-1865 stable 2026-01-26, ideas only —
 * không copy code/text/tài sản của bất kỳ repo nào).
 *
 * V15 mở rộng bridge v14 theo đúng SEP-1865:
 *
 *   App -> host (request, có `id`, host phải trả response):
 *   - `ui/initialize` — bắt tay: app gửi `clientInfo`; host trả
 *     host context v15 (theme/locale/timezone/platform/display
 *     mode/kích thước/capabilities) + session id. Mọi method khác
 *     trước `ui/initialize` đều bị từ chối (-32002).
 *   - `tools/call` — app xin gọi tool: host kiểm tra allowlist
 *     của session + consent (xem appsConsentV15) rồi mới thực thi.
 *     Đây là ĐƯỜNG DUY NHẤT app gọi tool.
 *   - `tools/list` — app xem tool nào nó được phép gọi (mới v15).
 *   - `resources/read` — app đọc resource `ui://` hoặc resource
 *     host cho phép (mới: kiểm tra allowlist resource).
 *   - `resources/list` — app liệt kê resource được phép đọc (mới v15).
 *   - `ui/open-link` — app xin mở link ngoài: chỉ http(s), host
 *     quyết định (mặc định chặn).
 *   - `ui/message` — app gửi message hiển thị/log về host.
 *   - `ui/post-message` — app gửi message vào chat (mới v15):
 *     nội dung đi qua host, host quyết định có đưa vào chat không.
 *   - `ui/update-model-context` — app báo model context mới.
 *   - `ui/close`, `ui/set-display-mode`, `ui/ready`, `ui/telemetry`.
 *
 *   Host -> app (notification, không có `id`):
 *   - `ui/model-context-updated`, `ui/message`,
 *     `ui/display-mode-changed` (kế thừa v14/dialect),
 *   - `ui/tool-result` — host đẩy kết quả tool chạy nền xuống app
 *     (mới v15, vd task dài chạy xong),
 *   - `ui/consent-decided` — host báo user đã quyết định consent
 *     cho một action app xin trước đó (mới v15).
 *
 * An toàn (fail-closed, giống v14): origin phải khớp kỳ vọng
 * (iframe srcdoc → "null"), method lạ → -32601, params sai →
 * -32602, chưa initialize → -32002, tool/resource ngoài allowlist
 * → -32003, rate limit (600 msg/phút/session) → -32003 kèm lý do.
 * Mọi message vào/ra đều ghi vào log của session để audit.
 *
 * Module này thuần (không DOM, không network): renderer chỉ việc
 * `postMessage` object host build ra, và đưa `event.data` vào đây.
 */

import {
  parseUiJsonRpcMessage,
  uiJsonRpcError,
  uiJsonRpcNotification,
  uiJsonRpcResult,
  UI_JSONRPC_ERROR_CODES,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type UiModelContext,
} from './appsUiDialect';
import { buildHostContextV15, type UiHostContextV15 } from './appsUiV15';

/** Method app → host được phép trong bridge v15. */
export const UI_V15_BRIDGE_METHODS = [
  'ui/initialize',
  'ui/update-model-context',
  'ui/message',
  'ui/open-link',
  'ui/post-message',
  'ui/close',
  'ui/set-display-mode',
  'ui/ready',
  'ui/telemetry',
  'tools/call',
  'tools/list',
  'resources/read',
  'resources/list',
] as const;
export type UiV15BridgeMethod = (typeof UI_V15_BRIDGE_METHODS)[number];

/** Notification host → app trong bridge v15. */
export const UI_V15_HOST_NOTIFICATIONS = [
  'ui/model-context-updated',
  'ui/host-context-updated',
  'ui/message',
  'ui/display-mode-changed',
  'ui/tool-result',
  'ui/consent-decided',
] as const;
export type UiV15HostNotification = (typeof UI_V15_HOST_NOTIFICATIONS)[number];

/** Origin của iframe srcdoc (opaque origin — postMessage báo "null"). */
export const UI_V15_SRCDOC_ORIGIN = 'null';
/** Số session bridge tối đa. */
export const UI_V15_BRIDGE_MAX_SESSIONS = 32;
/** Số message tối đa một session gửi trong 1 phút (chống spam/flood). */
export const UI_V15_BRIDGE_MAX_MESSAGES_PER_MINUTE = 600;
/** Số message log tối đa giữ trong một session. */
export const UI_V15_MAX_SESSION_LOG = 500;
/** Số request đang chờ (chưa có response) tối đa một session. */
export const UI_V15_MAX_PENDING_REQUESTS = 64;
/** Timeout mặc định chờ tool chạy (ms) — host báo cho app biết. */
export const UI_V15_DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Mã lỗi riêng của bridge v15 (mở rộng mã JSON-RPC chuẩn). */
export const UI_V15_ERROR_CODES = {
  ...UI_JSONRPC_ERROR_CODES,
  /** Action cần consent của user — chưa được quyết định. */
  consentRequired: -32010,
  /** Consent đã bị user từ chối. */
  consentDenied: -32011,
  /** Consent đã hết hạn (user không quyết định kịp). */
  consentExpired: -32012,
  /** Session bridge đã đóng / không tồn tại. */
  sessionClosed: -32013,
  /** App gửi quá nhiều message (rate limit). */
  rateLimited: -32014,
} as const;

export class UiBridgeV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UiBridgeV15Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function paramsAsRecord(request: JsonRpcRequest): Record<string, unknown> {
  if (isRecord(request.params)) return request.params;
  return {};
}

/**
 * Kiểm tra origin của message postMessage có khớp kỳ vọng không.
 * Iframe srcdoc có opaque origin nên `event.origin` là "null" —
 * host chỉ chấp nhận đúng giá trị này (hoặc origin tường minh đã
 * cấu hình cho app load từ URL). Origin khác → chặn, ghi audit.
 */
export function isAllowedV15Origin(origin: unknown, expectedOrigin: string): boolean {
  return typeof origin === 'string' && origin === expectedOrigin;
}

/** Kết quả validate một message bridge thô (trước khi dispatch). */
export interface V15MessageValidation {
  ok: boolean;
  request?: JsonRpcRequest;
  /** Lý do khi không ok (hiển thị được trong log). */
  reason?: string;
  /** Mã lỗi JSON-RPC tương ứng khi không ok. */
  errorCode?: number;
}

/**
 * Validate một message postMessage thô thành JSON-RPC request hợp lệ.
 * Trả `ok: false` (kèm mã lỗi) thay vì ném — host luôn trả response
 * lỗi về app thay vì im lặng, trừ notification (không có id).
 */
export function validateV15BridgeMessage(data: unknown): V15MessageValidation {
  let parsed: JsonRpcRequest | null = null;
  try {
    parsed = parseUiJsonRpcMessage(data);
  } catch {
    return {
      ok: false,
      reason: 'Message không phải JSON-RPC 2.0 hợp lệ.',
      errorCode: UI_JSONRPC_ERROR_CODES.parseError,
    };
  }
  if (!parsed) {
    return {
      ok: false,
      reason: 'Message không phải JSON-RPC 2.0 hợp lệ.',
      errorCode: UI_JSONRPC_ERROR_CODES.parseError,
    };
  }
  if (!(UI_V15_BRIDGE_METHODS as readonly string[]).includes(parsed.method)) {
    return {
      ok: false,
      request: parsed,
      reason: `Method không hỗ trợ trong bridge v15: "${parsed.method}".`,
      errorCode: UI_JSONRPC_ERROR_CODES.methodNotFound,
    };
  }
  if (parsed.method === 'tools/call') {
    const params = paramsAsRecord(parsed);
    if (typeof params['name'] !== 'string' || params['name'].trim() === '') {
      return {
        ok: false,
        request: parsed,
        reason: 'tools/call thiếu params.name (tên tool).',
        errorCode: UI_JSONRPC_ERROR_CODES.invalidParams,
      };
    }
  }
  if (parsed.method === 'resources/read') {
    const params = paramsAsRecord(parsed);
    if (typeof params['uri'] !== 'string' || params['uri'].trim() === '') {
      return {
        ok: false,
        request: parsed,
        reason: 'resources/read thiếu params.uri.',
        errorCode: UI_JSONRPC_ERROR_CODES.invalidParams,
      };
    }
  }
  if (parsed.method === 'ui/open-link') {
    const params = paramsAsRecord(parsed);
    if (typeof params['url'] !== 'string' || params['url'].trim() === '') {
      return {
        ok: false,
        request: parsed,
        reason: 'ui/open-link thiếu params.url.',
        errorCode: UI_JSONRPC_ERROR_CODES.invalidParams,
      };
    }
  }
  if (parsed.method === 'ui/post-message') {
    const params = paramsAsRecord(parsed);
    if (typeof params['text'] !== 'string' || params['text'].trim() === '') {
      return {
        ok: false,
        request: parsed,
        reason: 'ui/post-message thiếu params.text.',
        errorCode: UI_JSONRPC_ERROR_CODES.invalidParams,
      };
    }
  }
  return { ok: true, request: parsed };
}

/** Một dòng log message trong session bridge. */
export interface V15BridgeLogEntry {
  atMs: number;
  direction: 'in' | 'out';
  method: string;
  id?: JsonRpcId;
  /** true khi message bị chặn/lỗi. */
  blocked: boolean;
  reason?: string;
}

/** Request đang chờ xử lý (tools/call qua consent) trong session. */
export interface V15PendingBridgeRequest {
  id: JsonRpcId;
  method: string;
  toolName?: string;
  /** Args gốc của tools/call — chạy lại sau khi consent duyệt. */
  args?: Record<string, unknown>;
  createdAtMs: number;
  /** Consent id gắn với request này (khi có). */
  consentId?: string;
}

/** Snapshot nhẹ của một session bridge (cho panel/debug). */
export interface UiBridgeV15SessionSnapshot {
  sessionId: string;
  appUri: string;
  serverName: string;
  toolName?: string;
  initialized: boolean;
  origin: string;
  displayMode: 'inline' | 'fullscreen' | 'pip';
  allowedTools: string[];
  allowedResources: string[];
  allowOpenLink: boolean;
  allowPostMessage: boolean;
  messagesIn: number;
  messagesOut: number;
  blockedMessages: number;
  pendingRequests: number;
  createdAtMs: number;
  lastMessageAtMs: number;
}

export interface UiBridgeV15SessionOptions {
  /** Tool đã tạo ra app (mặc định: chỉ tool này được gọi; cũng là fallback cho allowedTools). */
  toolName?: string;
  /** Tool app được phép gọi (mặc định: chỉ tool tạo ra app). */
  allowedTools?: string[];
  /** Resource app được phép đọc (mặc định: chỉ resource của chính app). */
  allowedResources?: string[];
  /** App có được mở link ngoài không (mặc định false). */
  allowOpenLink?: boolean;
  /** App có được post message vào chat không (mặc định false). */
  allowPostMessage?: boolean;
  /** Origin kỳ vọng (mặc định 'null' — iframe srcdoc). */
  expectedOrigin?: string;
  /** Display mode ban đầu. */
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Host context build sẵn cho ui/initialize (mặc định: build từ option). */
  hostContext?: UiHostContextV15;
  /** Theme/locale/timezone/platform cho host context mặc định. */
  theme?: UiHostContextV15['theme'];
  locale?: string;
  timezone?: string;
  platform?: string;
}

export interface UiBridgeHostV15Options {
  now?: () => number;
  /** Handler thực thi tools/call cho app (đi qua consent ở tầng host). */
  onToolsCall?: (
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  /** Handler đọc resource cho app. */
  onResourcesRead?: (sessionId: string, uri: string) => Promise<unknown> | unknown;
  /** Handler liệt kê resource cho app. */
  onResourcesList?: (sessionId: string) => Promise<unknown[]> | unknown[];
  /** Handler quyết định mở link ngoài. */
  onOpenLink?: (sessionId: string, url: string) => boolean | Promise<boolean>;
  /** App gửi message vào chat — host quyết định có đưa vào chat không. */
  onPostMessage?: (sessionId: string, text: string) => boolean | Promise<boolean>;
  /** App gửi message hiển thị/log về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** App cập nhật model context. */
  onModelContext?: (sessionId: string, context: UiModelContext) => void;
  /** App xin đóng chính nó. */
  onClose?: (sessionId: string) => void;
  /** App xin đổi display mode. */
  onDisplayMode?: (sessionId: string, mode: 'inline' | 'fullscreen' | 'pip') => void;
  /** Consent mới cần user quyết định (host v15 gọi khi tools/call cần consent). */
  onConsentRequired?: (sessionId: string, request: JsonRpcRequest) => string | undefined;
  /** Callback mỗi khi có message bị chặn (để audit). */
  onBlocked?: (sessionId: string, reason: string, method?: string) => void;
}

/**
 * Một session bridge v15: một app đang mở, một iframe, một kênh
 * postMessage. Session giữ trạng thái initialize, allowlist tool /
 * resource, rate limit, log message, và request đang chờ (consent).
 */
export class UiBridgeV15Session {
  readonly sessionId: string;
  readonly appUri: string;
  readonly serverName: string;
  readonly toolName?: string;
  readonly expectedOrigin: string;
  readonly allowedTools: string[];
  readonly allowedResources: string[];
  readonly allowOpenLink: boolean;
  readonly allowPostMessage: boolean;
  displayMode: 'inline' | 'fullscreen' | 'pip';
  initialized = false;
  clientInfo?: Record<string, unknown>;
  modelContext?: UiModelContext;
  readonly createdAtMs: number;
  lastMessageAtMs: number;
  messagesIn = 0;
  messagesOut = 0;
  blockedMessages = 0;
  private readonly now: () => number;
  private readonly hostContext: UiHostContextV15;
  private readonly log: V15BridgeLogEntry[] = [];
  private readonly pending = new Map<string, V15PendingBridgeRequest>();
  private readonly minuteWindow: number[] = [];

  constructor(
    sessionId: string,
    appUri: string,
    serverName: string,
    options: UiBridgeV15SessionOptions & { now: () => number },
  ) {
    this.sessionId = sessionId;
    this.appUri = appUri;
    this.serverName = serverName;
    this.toolName = options.toolName;
    this.expectedOrigin = options.expectedOrigin ?? UI_V15_SRCDOC_ORIGIN;
    this.allowedTools = [...(options.allowedTools ?? (options.toolName ? [options.toolName] : []))];
    this.allowedResources = [...(options.allowedResources ?? [appUri])];
    this.allowOpenLink = options.allowOpenLink ?? false;
    this.allowPostMessage = options.allowPostMessage ?? false;
    this.displayMode = options.displayMode ?? 'inline';
    this.now = options.now;
    this.createdAtMs = this.now();
    this.lastMessageAtMs = this.createdAtMs;
    this.hostContext =
      options.hostContext ??
      buildHostContextV15({
        sessionId,
        theme: options.theme,
        locale: options.locale,
        timezone: options.timezone,
        platform: options.platform,
        displayMode: this.displayMode,
      });
  }

  /** Host context trả cho app trong `ui/initialize`. */
  getHostContext(): UiHostContextV15 {
    return { ...this.hostContext, displayMode: this.displayMode, sessionId: this.sessionId };
  }

  /** Kiểm tra rate limit: tối đa N message/phút, trượt theo thời gian. */
  checkRateLimit(): boolean {
    const nowMs = this.now();
    const cutoff = nowMs - 60_000;
    while (this.minuteWindow.length > 0 && (this.minuteWindow[0] as number) < cutoff) {
      this.minuteWindow.shift();
    }
    if (this.minuteWindow.length >= UI_V15_BRIDGE_MAX_MESSAGES_PER_MINUTE) return false;
    this.minuteWindow.push(nowMs);
    return true;
  }

  /** Ghi một message vào log session (giữ tối đa N dòng mới nhất). */
  record(direction: 'in' | 'out', method: string, id: JsonRpcId | undefined, blocked: boolean, reason?: string): void {
    this.log.push({
      atMs: this.now(),
      direction,
      method,
      ...(id !== undefined ? { id } : {}),
      blocked,
      ...(reason ? { reason } : {}),
    });
    if (this.log.length > UI_V15_MAX_SESSION_LOG) {
      this.log.splice(0, this.log.length - UI_V15_MAX_SESSION_LOG);
    }
    if (direction === 'in') this.messagesIn += 1;
    else this.messagesOut += 1;
    if (blocked) this.blockedMessages += 1;
    this.lastMessageAtMs = this.now();
  }

  /** Log message của session (mới nhất cuối). */
  getLog(): V15BridgeLogEntry[] {
    return [...this.log];
  }

  /** Đăng ký một request đang chờ (tools/call qua consent). */
  trackPending(id: JsonRpcId, method: string, toolName?: string, consentId?: string, args?: Record<string, unknown>): void {
    if (this.pending.size >= UI_V15_MAX_PENDING_REQUESTS) {
      // Hết chỗ: xoá request cũ nhất để không kẹt session.
      const oldest = [...this.pending.keys()][0];
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(String(id), {
      id,
      method,
      ...(toolName ? { toolName } : {}),
      ...(args ? { args } : {}),
      createdAtMs: this.now(),
      ...(consentId ? { consentId } : {}),
    });
  }

  /** Lấy + xoá một pending request theo id (khi consent đã quyết). */
  takePending(id: JsonRpcId): V15PendingBridgeRequest | undefined {
    const key = String(id);
    const found = this.pending.get(key);
    if (found) this.pending.delete(key);
    return found;
  }

  /** Liệt kê pending request (cho panel/debug). */
  listPending(): V15PendingBridgeRequest[] {
    return [...this.pending.values()];
  }

  snapshot(): UiBridgeV15SessionSnapshot {
    return {
      sessionId: this.sessionId,
      appUri: this.appUri,
      serverName: this.serverName,
      ...(this.toolName ? { toolName: this.toolName } : {}),
      initialized: this.initialized,
      origin: this.expectedOrigin,
      displayMode: this.displayMode,
      allowedTools: [...this.allowedTools],
      allowedResources: [...this.allowedResources],
      allowOpenLink: this.allowOpenLink,
      allowPostMessage: this.allowPostMessage,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      blockedMessages: this.blockedMessages,
      pendingRequests: this.pending.size,
      createdAtMs: this.createdAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
    };
  }
}

/**
 * Host bridge v15 — quản lý session + dispatch message postMessage
 * JSON-RPC 2.0 từ app. Mọi quyết định (allowlist, origin, rate
 * limit, initialize, consent) đều ở đây, thuần và test được.
 */
export class UiBridgeHostV15 {
  private readonly now: () => number;
  private readonly options: UiBridgeHostV15Options;
  private readonly sessions = new Map<string, UiBridgeV15Session>();
  private sessionCounter = 0;

  constructor(options: UiBridgeHostV15Options = {}) {
    this.now = options.now ?? Date.now;
    this.options = options;
  }

  /** Số session đang mở. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Tạo session bridge mới cho một app đã đăng ký. Ném khi đã đủ
   * số session tối đa. Session chưa initialized cho tới khi app gửi
   * `ui/initialize`.
   */
  createSession(
    appUri: string,
    serverName: string,
    options: UiBridgeV15SessionOptions = {},
  ): UiBridgeV15Session {
    if (this.sessions.size >= UI_V15_BRIDGE_MAX_SESSIONS) {
      throw new UiBridgeV15Error(
        `Đã mở tối đa ${UI_V15_BRIDGE_MAX_SESSIONS} session bridge — đóng app khác trước.`,
        'ui-v15-too-many-sessions',
      );
    }
    this.sessionCounter += 1;
    const sessionId = `v15-${this.now()}-${this.sessionCounter}`;
    const session = new UiBridgeV15Session(sessionId, appUri, serverName, {
      ...options,
      now: this.now,
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): UiBridgeV15Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Đóng session (app đóng / host đóng). Trả false khi không có session. */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  listSessions(): UiBridgeV15SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  /**
   * Xử lý một message postMessage từ app. Trả JSON-RPC response
   * (renderer `postMessage` ngược lại cho iframe) hoặc `null` khi
   * message là notification (không cần response) hay message bị
   * chặn mà không có id để trả lỗi.
   *
   * Thứ tự kiểm tra (fail-closed):
   *   1. Session tồn tại, origin khớp.
   *   2. Rate limit.
   *   3. Message là JSON-RPC 2.0 + method hỗ trợ + params đủ.
   *   4. Đã initialize (trừ `ui/initialize`).
   *   5. Dispatch theo method (allowlist tool/resource, open-link...).
   */
  async handleMessage(
    sessionId: string,
    data: unknown,
    origin: unknown,
  ): Promise<JsonRpcResponse | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return uiJsonRpcError(
        null,
        UI_V15_ERROR_CODES.sessionClosed,
        `Session bridge ${sessionId} không tồn tại hoặc đã đóng.`,
      );
    }
    if (!isAllowedV15Origin(origin, session.expectedOrigin)) {
      session.record('in', 'unknown', undefined, true, `Origin không khớp kỳ vọng (${String(origin)}).`);
      this.options.onBlocked?.(sessionId, `Origin không khớp: ${String(origin)}.`, undefined);
      return null;
    }
    if (!session.checkRateLimit()) {
      session.record('in', 'unknown', undefined, true, 'Quá nhiều message (rate limit).');
      this.options.onBlocked?.(sessionId, 'Rate limit: app gửi quá nhiều message.', undefined);
      return uiJsonRpcError(
        null,
        UI_V15_ERROR_CODES.rateLimited,
        `App gửi quá ${UI_V15_BRIDGE_MAX_MESSAGES_PER_MINUTE} message/phút — bị chặn tạm thời.`,
      );
    }
    const validation = validateV15BridgeMessage(data);
    if (!validation.ok || !validation.request) {
      const id =
        isRecord(data) && (typeof data['id'] === 'string' || typeof data['id'] === 'number')
          ? (data['id'] as JsonRpcId)
          : null;
      const method = isRecord(data) ? String(data['method'] ?? 'unknown') : 'unknown';
      session.record('in', method, id ?? undefined, true, validation.reason);
      this.options.onBlocked?.(sessionId, validation.reason ?? 'Message không hợp lệ.', method);
      if (id === null) return null;
      return uiJsonRpcError(id, validation.errorCode ?? UI_JSONRPC_ERROR_CODES.invalidRequest, validation.reason ?? 'Message không hợp lệ.');
    }
    const request = validation.request;
    const id = request.id ?? null;
    const isNotification = request.id === undefined;
    session.record('in', request.method, id ?? undefined, false);
    if (request.method !== 'ui/initialize' && !session.initialized) {
      // Đã ghi message ở trên (không đếm vào blockedMessages: đây là lỗi
      // protocol -32002 có trả lời, không phải message bị chặn bảo mật).
      if (isNotification) return null;
      return uiJsonRpcError(
        id,
        UI_JSONRPC_ERROR_CODES.notInitialized,
        'App phải gửi ui/initialize trước khi gọi method khác.',
      );
    }
    const response = await this.dispatch(session, request);
    if (response) {
      session.record('out', request.method, response.id, response.error !== undefined, response.error?.message);
    }
    return response;
  }

  /** Dispatch một request đã validate theo method. */
  private async dispatch(
    session: UiBridgeV15Session,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse | null> {
    const id = request.id ?? null;
    const isNotification = request.id === undefined;
    const params = paramsAsRecord(request);
    const deny = (code: number, message: string): JsonRpcResponse | null =>
      isNotification ? null : uiJsonRpcError(id, code, message);
    const ok = (result: unknown): JsonRpcResponse | null =>
      isNotification ? null : uiJsonRpcResult(id, result);

    switch (request.method) {
      case 'ui/initialize': {
        session.initialized = true;
        if (isRecord(params['clientInfo'])) {
          session.clientInfo = params['clientInfo'] as Record<string, unknown>;
        }
        return ok({
          protocolVersion: 'ui/1.0',
          hostVersion: '15.0.0',
          sessionId: session.sessionId,
          hostContext: session.getHostContext(),
        });
      }
      case 'ui/ready': {
        return ok({ ok: true, sessionId: session.sessionId });
      }
      case 'ui/update-model-context': {
        const context = (params['context'] ?? params) as UiModelContext;
        if (isRecord(context)) {
          session.modelContext = context as UiModelContext;
          this.options.onModelContext?.(session.sessionId, context as UiModelContext);
        }
        return ok({ ok: true, appliedKeys: Object.keys(context ?? {}) });
      }
      case 'ui/message': {
        const text = asNonEmptyString(params['text'] ?? params['message']);
        const levelRaw = params['level'];
        const level: 'info' | 'warn' | 'error' =
          levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info';
        if (text) this.options.onMessage?.(session.sessionId, text, level);
        return ok({ ok: true });
      }
      case 'ui/telemetry': {
        // Telemetry từ app: chỉ ghi nhận, không trả dữ liệu gì về.
        return ok({ ok: true });
      }
      case 'ui/close': {
        this.options.onClose?.(session.sessionId);
        return ok({ ok: true, closed: true });
      }
      case 'ui/set-display-mode': {
        const mode = params['mode'];
        if (mode !== 'inline' && mode !== 'fullscreen' && mode !== 'pip') {
          return deny(UI_JSONRPC_ERROR_CODES.invalidParams, 'ui/set-display-mode cần params.mode là inline/fullscreen/pip.');
        }
        session.displayMode = mode;
        this.options.onDisplayMode?.(session.sessionId, mode);
        return ok({ ok: true, displayMode: mode });
      }
      case 'ui/open-link': {
        const url = String(params['url'] ?? '');
        if (!/^https?:\/\//i.test(url)) {
          return deny(UI_JSONRPC_ERROR_CODES.forbidden, 'ui/open-link chỉ mở link http(s).');
        }
        if (!session.allowOpenLink) {
          return deny(UI_JSONRPC_ERROR_CODES.forbidden, 'App này không được phép mở link ngoài (allowOpenLink=false).');
        }
        let opened = false;
        if (this.options.onOpenLink) {
          opened = await this.options.onOpenLink(session.sessionId, url);
        }
        return ok({ ok: true, opened });
      }
      case 'ui/post-message': {
        const text = String(params['text'] ?? '');
        if (text.length > 10_000) {
          return deny(UI_JSONRPC_ERROR_CODES.invalidParams, 'ui/post-message tối đa 10.000 ký tự.');
        }
        if (!session.allowPostMessage) {
          return deny(UI_JSONRPC_ERROR_CODES.forbidden, 'App này không được phép post message vào chat (allowPostMessage=false).');
        }
        let accepted = false;
        if (this.options.onPostMessage) {
          accepted = await this.options.onPostMessage(session.sessionId, text);
        }
        return ok({ ok: true, accepted });
      }
      case 'tools/list': {
        return ok({
          tools: session.allowedTools.map((name) => ({ name })),
          total: session.allowedTools.length,
        });
      }
      case 'tools/call': {
        const toolName = String(params['name'] ?? '');
        const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
        if (!session.allowedTools.includes(toolName)) {
          return deny(
            UI_JSONRPC_ERROR_CODES.forbidden,
            `Tool "${toolName}" không nằm trong allowlist của app này — app chỉ được gọi: ${session.allowedTools.join(', ') || '(không có tool nào)'}.`,
          );
        }
        // Consent: host v15 hỏi tầng consent qua callback. Callback
        // trả consent id khi cần user quyết — request được giữ pending
        // và host trả lỗi consentRequired (app chờ notification
        // ui/consent-decided rồi gọi lại).
        if (this.options.onConsentRequired) {
          const consentId = this.options.onConsentRequired(session.sessionId, request);
          if (consentId) {
            session.trackPending(id, 'tools/call', toolName, consentId, args);
            return deny(
              UI_V15_ERROR_CODES.consentRequired,
              `Gọi tool "${toolName}" cần user duyệt (consent ${consentId}).`,
            );
          }
        }
        if (!this.options.onToolsCall) {
          return deny(UI_JSONRPC_ERROR_CODES.internalError, 'Host chưa cấu hình handler tools/call.');
        }
        try {
          const result = await this.options.onToolsCall(session.sessionId, toolName, args);
          return ok({ ok: true, tool: toolName, result });
        } catch (err) {
          return deny(
            UI_JSONRPC_ERROR_CODES.internalError,
            `Tool "${toolName}" lỗi: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      case 'resources/list': {
        let listed: unknown[] = session.allowedResources.map((uri) => ({ uri }));
        if (this.options.onResourcesList) {
          listed = await this.options.onResourcesList(session.sessionId);
        }
        return ok({ resources: listed, total: listed.length });
      }
      case 'resources/read': {
        const uri = String(params['uri'] ?? '');
        if (!session.allowedResources.includes(uri) && !uri.startsWith('ui://')) {
          return deny(
            UI_JSONRPC_ERROR_CODES.forbidden,
            `Resource "${uri}" không nằm trong allowlist của app này.`,
          );
        }
        if (!session.allowedResources.includes(uri)) {
          return deny(
            UI_JSONRPC_ERROR_CODES.forbidden,
            `Resource "${uri}" không nằm trong allowlist của app này — app chỉ được đọc: ${session.allowedResources.join(', ')}.`,
          );
        }
        if (!this.options.onResourcesRead) {
          return deny(UI_JSONRPC_ERROR_CODES.internalError, 'Host chưa cấu hình handler resources/read.');
        }
        try {
          const contents = await this.options.onResourcesRead(session.sessionId, uri);
          return ok({ ok: true, uri, contents });
        } catch (err) {
          return deny(
            UI_JSONRPC_ERROR_CODES.internalError,
            `Đọc resource "${uri}" lỗi: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      default: {
        return deny(UI_JSONRPC_ERROR_CODES.methodNotFound, `Method không hỗ trợ: "${request.method}".`);
      }
    }
  }

  // -- notification host -> app (renderer postMessage object này) ----------

  /** Build notification `ui/model-context-updated` cho app. */
  notifyModelContextUpdated(sessionId: string, context: UiModelContext): Record<string, unknown> {
    return uiJsonRpcNotification('ui/model-context-updated', {
      sessionId,
      context,
    }) as unknown as Record<string, unknown>;
  }

  /** Build notification `ui/message` (host gửi message xuống app). */
  notifyMessage(sessionId: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): Record<string, unknown> {
    return uiJsonRpcNotification('ui/message', { sessionId, text, level }) as unknown as Record<string, unknown>;
  }

  /** Build notification `ui/display-mode-changed`. */
  notifyDisplayModeChanged(sessionId: string, mode: 'inline' | 'fullscreen' | 'pip'): Record<string, unknown> {
    return uiJsonRpcNotification('ui/display-mode-changed', { sessionId, mode }) as unknown as Record<string, unknown>;
  }

  /** Build notification `ui/tool-result` (task nền chạy xong). */
  notifyToolResult(sessionId: string, toolName: string, result: unknown): Record<string, unknown> {
    // 'ui/tool-result' là notification riêng của v15 (ngoài union
    // UiDialectHostNotification của dialect) nên build literal trực
    // tiếp thay vì qua uiJsonRpcNotification.
    return { jsonrpc: '2.0', method: 'ui/tool-result', params: { sessionId, tool: toolName, result } };
  }

  /** Build notification `ui/consent-decided` (user đã quyết consent). */
  notifyConsentDecided(
    sessionId: string,
    consentId: string,
    decision: 'approved' | 'denied' | 'expired',
    toolName?: string,
  ): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      method: 'ui/consent-decided',
      params: {
        sessionId,
        consentId,
        decision,
        ...(toolName ? { tool: toolName } : {}),
      },
    };
  }

  /**
   * Hoàn tất một request tools/call đang pending sau khi consent đã
   * quyết: user duyệt → chạy tool và trả response; user từ chối →
   * trả lỗi consentDenied. Trả null khi không có pending request.
   */
  async resolvePendingAfterConsent(
    sessionId: string,
    requestId: JsonRpcId,
    decision: 'approved' | 'denied',
  ): Promise<JsonRpcResponse | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const pending = session.takePending(requestId);
    if (!pending || pending.method !== 'tools/call' || !pending.toolName) return null;
    if (decision === 'denied') {
      return uiJsonRpcError(
        requestId,
        UI_V15_ERROR_CODES.consentDenied,
        `User đã từ chối cho app gọi tool "${pending.toolName}".`,
      );
    }
    if (!this.options.onToolsCall) {
      return uiJsonRpcError(requestId, UI_JSONRPC_ERROR_CODES.internalError, 'Host chưa cấu hình handler tools/call.');
    }
    try {
      const result = await this.options.onToolsCall(sessionId, pending.toolName, pending.args ?? {});
      return uiJsonRpcResult(requestId, { ok: true, tool: pending.toolName, result });
    } catch (err) {
      return uiJsonRpcError(
        requestId,
        UI_JSONRPC_ERROR_CODES.internalError,
        `Tool "${pending.toolName}" lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
