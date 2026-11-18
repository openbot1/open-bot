/**
 * MCP Apps host v14 — bridge postMessage JSON-RPC `ui/*` (SEP-1865
 * stable 2026-01-26, ideas only — không copy code/text/tài sản của
 * bất kỳ repo nào).
 *
 * Host ↔ view nói chuyện JSON-RPC 2.0 qua `postMessage`:
 *
 *   view → host (request, cần `id`):
 *     - `ui/initialize` — bắt tay: view gửi client info, host trả
 *       protocol version + host context + capability host hỗ trợ.
 *     - `ui/update-model-context` — view báo model context mới.
 *     - `tools/call` — view xin gọi tool (ĐI QUA CONSENT + AUDIT
 *       như tool call trực tiếp — UI là input surface cho model,
 *       không phải đường vòng qua model).
 *     - `resources/read` — view xin đọc resource `ui://` (chỉ
 *       resource đã đăng ký, chỉ MIME app).
 *     - `ui/open-link` — view xin mở link ngoài (host quyết định
 *       theo allow-list, mặc định chặn).
 *     - `ui/close`, `ui/set-display-mode` — view xin đóng / đổi mode.
 *     - `ui/message` — view log message (info/warn/error).
 *     - `ui/telemetry` — view gửi telemetry (không chứa PII).
 *     - `ui/ready` — view báo đã mount xong.
 *
 *   host → view (notification, không `id`):
 *     - `ui/model-context-updated` — host đẩy model context mới.
 *     - `ui/host-context-updated` — host đẩy host context mới.
 *
 * Bảo mật (fail-closed):
 *   - Origin: iframe srcdoc có origin mờ (`"null"`) — host CHỈ
 *     chấp nhận origin đã đăng ký lúc tạo session (`"null"` cho
 *     srcdoc, hoặc origin https cụ thể cho app load từ host cho
 *     phép). Origin khác → message bị drop + ghi audit.
 *   - Định dạng: message phải là JSON-RPC 2.0 hợp lệ, method nằm
 *     trong allow-list, params là object, id là string/number.
 *     Message sai → lỗi JSON-RPC -32600 (không throw, không crash).
 *   - Session: message không có session hợp lệ / chưa initialize
 *     mà gọi `tools/call` → từ chối -32002.
 *   - Consent: mọi `tools/call` từ UI đều qua consent (trừ tool
 *     nằm trong `autoApproveTools` mà host cấu hình tường minh).
 *     Chưa có quyết định consent → trả lỗi -32001 `consent-required`
 *     kèm `consentId`; view/host UI hiện hộp consent; khi user
 *     duyệt/từ chối thì view gọi lại.
 *   - Audit: mọi action từ UI (kể cả bị từ chối) đều ghi vào
 *     `McpAuditLog` (hash chain) + bảng action riêng cho panel.
 *
 * Module thuần (không DOM, không network): renderer lấy response
 * trả về rồi `postMessage` ngược vào iframe.
 */

import { McpAuditLog, type McpAuditEntry } from './auditLog';
import {
  buildDefaultHostContext,
  buildUiInitializeResult,
  uiJsonRpcError,
  uiJsonRpcNotification,
  uiJsonRpcResult,
  UI_JSONRPC_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type UiHostContext,
  type UiModelContext,
} from './appsUiDialect';
import type { McpAppsUiRegistryV14 } from './appsUiV14';

/** Method view → host được phép trong bridge v14. */
export const UI_V14_BRIDGE_METHODS = [
  'ui/initialize',
  'ui/update-model-context',
  'ui/message',
  'ui/open-link',
  'ui/close',
  'ui/set-display-mode',
  'ui/ready',
  'ui/telemetry',
  'tools/call',
  'resources/read',
] as const;
export type UiV14BridgeMethod = (typeof UI_V14_BRIDGE_METHODS)[number];

/** Notification host → view trong bridge v14. */
export const UI_V14_HOST_NOTIFICATIONS = [
  'ui/model-context-updated',
  'ui/host-context-updated',
] as const;
export type UiV14HostNotification = (typeof UI_V14_HOST_NOTIFICATIONS)[number];

/** Origin của iframe srcdoc (opaque origin — postMessage báo "null"). */
export const UI_V14_SRCDOC_ORIGIN = 'null';
/** Số session bridge tối đa. */
export const UI_V14_BRIDGE_MAX_SESSIONS = 32;
/** Số message tối đa một session gửi trong 1 phút (chống spam/flood). */
export const UI_V14_BRIDGE_MAX_MESSAGES_PER_MINUTE = 600;
/** Số consent đang chờ tối đa. */
export const UI_V14_MAX_PENDING_CONSENTS = 64;
/** Số action audit tối đa giữ trong bộ nhớ (bản sao nhẹ cho panel). */
export const UI_V14_MAX_ACTION_LOG = 2_000;

/** Mã lỗi JSON-RPC riêng của bridge v14. */
export const UI_V14_ERROR_CODES = {
  ...UI_JSONRPC_ERROR_CODES,
  /** Cần consent của user trước khi chạy action. */
  consentRequired: -32001,
  /** Session chưa initialize. */
  notInitialized: -32002,
  /** Origin không được phép. */
  badOrigin: -32003,
  /** Tool/resource không được phép với session này. */
  forbidden: -32004,
  /** Vượt giới hạn tốc độ message. */
  rateLimited: -32005,
} as const;

export class UiBridgeV14Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UiBridgeV14Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isJsonRpcId(value: unknown): value is string | number {
  return (
    (typeof value === 'string' && value !== '') ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Một message JSON-RPC đã validate từ view. */
export interface V14BridgeMessage {
  jsonrpc: '2.0';
  method: UiV14BridgeMethod;
  params: Record<string, unknown>;
  /** undefined = notification (không cần response). */
  id?: string | number;
}

/** Kết quả validate một message thô (không throw). */
export interface V14MessageValidation {
  ok: boolean;
  message?: V14BridgeMessage;
  /** Mã lỗi JSON-RPC khi không ok. */
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Validate một message postMessage thô từ view.
 * Kiểm tra: là object, `jsonrpc === '2.0'`, `method` là chuỗi nằm
 * trong allow-list, `params` (nếu có) là object, `id` (nếu có) là
 * string/number. Trả `{ ok: false, ... }` thay vì throw để host
 * trả lỗi JSON-RPC đúng chuẩn cho view.
 */
export function validateV14BridgeMessage(data: unknown): V14MessageValidation {
  if (!isRecord(data)) {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.invalidRequest,
      errorMessage: 'Message từ app phải là object JSON-RPC 2.0.',
    };
  }
  if (data['jsonrpc'] !== '2.0') {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.invalidRequest,
      errorMessage: 'Message từ app phải có jsonrpc "2.0".',
    };
  }
  const method = data['method'];
  if (typeof method !== 'string' || method === '') {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.invalidRequest,
      errorMessage: 'Message từ app thiếu method.',
    };
  }
  if (!(UI_V14_BRIDGE_METHODS as readonly string[]).includes(method)) {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.methodNotFound,
      errorMessage: `Method "${method}" không được phép trong bridge MCP Apps v14.`,
    };
  }
  const params = data['params'];
  if (params !== undefined && !isRecord(params)) {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.invalidParams,
      errorMessage: `Params của "${method}" phải là object.`,
    };
  }
  const id = data['id'];
  if (id !== undefined && id !== null && !isJsonRpcId(id)) {
    return {
      ok: false,
      errorCode: UI_JSONRPC_ERROR_CODES.invalidRequest,
      errorMessage: 'id của message JSON-RPC phải là string hoặc number.',
    };
  }
  return {
    ok: true,
    message: {
      jsonrpc: '2.0',
      method: method as UiV14BridgeMethod,
      params: (params ?? {}) as Record<string, unknown>,
      ...(isJsonRpcId(id) ? { id } : {}),
    },
  };
}

/**
 * Validate origin của một event postMessage.
 * `expectedOrigin` là origin đã đăng ký lúc tạo session:
 * `"null"` cho iframe srcdoc, hoặc origin https cụ thể.
 * Origin khác → từ chối. `"*"` không bao giờ là origin hợp lệ.
 */
export function isAllowedV14Origin(origin: unknown, expectedOrigin: string): boolean {
  if (typeof origin !== 'string') return false;
  if (origin === '*') return false;
  return origin === expectedOrigin;
}

/** Trạng thái consent của một action từ UI. */
export type UiV14ConsentStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** Một yêu cầu consent đang chờ user quyết định. */
export interface UiV14ConsentRequest {
  consentId: string;
  sessionId: string;
  appUri: string;
  /** Tool view xin gọi (hoặc 'open-link' cho link ngoài). */
  action: string;
  /** Argument đã redact để hiện trong hộp consent (không lộ secret). */
  argsSummary: string;
  status: UiV14ConsentStatus;
  requestedAtMs: number;
  decidedAtMs?: number;
  decidedBy?: string;
}

/** Một action từ UI đã ghi audit (bản sao nhẹ cho panel). */
export interface UiV14ActionLogEntry {
  seq: number;
  atMs: number;
  sessionId: string;
  appUri: string;
  method: string;
  tool?: string;
  outcome: 'ok' | 'denied' | 'error' | 'consent-required' | 'dropped';
  detail: string;
  consentId?: string;
}

/** Tuỳ chọn tạo session bridge v14. */
export interface UiBridgeV14SessionOptions {
  appUri: string;
  /** Origin kỳ vọng: 'null' cho srcdoc, hoặc origin https cụ thể. */
  expectedOrigin?: string;
  /** Tool session này được phép gọi (rỗng = không được gọi tool nào). */
  allowedTools?: readonly string[];
  /** Tool được auto-approve không cần consent (host cấu hình tường minh). */
  autoApproveTools?: readonly string[];
  /** Resource uri:// session này được phép đọc (mặc định: chỉ appUri). */
  allowedResourceUris?: readonly string[];
  /** App có được mở link ngoài không (mặc định: không). */
  allowOpenLink?: boolean;
  hostContext?: UiHostContext;
}

/** Snapshot một session bridge v14 (không lộ handler). */
export interface UiBridgeV14SessionSnapshot {
  sessionId: string;
  appUri: string;
  expectedOrigin: string;
  initialized: boolean;
  ready: boolean;
  allowedTools: string[];
  modelContext: UiModelContext;
  createdAtMs: number;
  lastSeenAtMs: number;
  messagesHandled: number;
  messagesRejected: number;
}

export interface UiBridgeHostV14Options {
  now?: () => number;
  registry?: McpAppsUiRegistryV14;
  auditLog?: McpAuditLog;
  /** Handler thực thi tools/call cho app (trả kết quả JSON thuần). */
  onToolsCall?: (
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  /** Handler quyết định mở link ngoài (trả true = mở). */
  onOpenLink?: (sessionId: string, url: string) => boolean | Promise<boolean>;
  /** App gửi message log về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** App cập nhật model context. */
  onModelContext?: (sessionId: string, context: UiModelContext) => void;
  /** Consent mới cần user quyết định (để UI hiện hộp consent). */
  onConsentRequested?: (consent: UiV14ConsentRequest) => void;
  /** TTL của consent đang chờ (ms, mặc định 5 phút). */
  consentTtlMs?: number;
}

interface V14SessionState {
  sessionId: string;
  appUri: string;
  expectedOrigin: string;
  allowedTools: Set<string>;
  autoApproveTools: Set<string>;
  allowedResourceUris: Set<string>;
  allowOpenLink: boolean;
  hostContext: UiHostContext;
  initialized: boolean;
  ready: boolean;
  modelContext: UiModelContext;
  createdAtMs: number;
  lastSeenAtMs: number;
  messagesHandled: number;
  messagesRejected: number;
  /** Số message trong cửa sổ 1 phút hiện tại + mốc cửa sổ. */
  windowStartMs: number;
  windowCount: number;
}

/**
 * Host-side bridge v14 — nhận postMessage từ view, validate,
 * định tuyến, consent + audit cho mọi action.
 *
 * Renderer chỉ cần: lấy `event.origin` + `event.data`, gọi
 * `handlePostMessage(sessionId, origin, data)`, rồi `postMessage`
 * response trả về vào iframe (kèm `targetOrigin` đúng).
 */
export class UiBridgeHostV14 {
  private readonly now: () => number;
  private readonly registry?: McpAppsUiRegistryV14;
  private readonly auditLog: McpAuditLog;
  private readonly onToolsCall?: UiBridgeHostV14Options['onToolsCall'];
  private readonly onOpenLink?: UiBridgeHostV14Options['onOpenLink'];
  private readonly onMessage?: UiBridgeHostV14Options['onMessage'];
  private readonly onModelContext?: UiBridgeHostV14Options['onModelContext'];
  private readonly onConsentRequested?: UiBridgeHostV14Options['onConsentRequested'];
  private readonly consentTtlMs: number;
  private readonly sessions = new Map<string, V14SessionState>();
  private readonly consents = new Map<string, UiV14ConsentRequest>();
  private readonly actionLog: UiV14ActionLogEntry[] = [];
  private sessionSeq = 0;
  private consentSeq = 0;
  private actionSeq = 0;

  constructor(options: UiBridgeHostV14Options = {}) {
    this.now = options.now ?? Date.now;
    this.registry = options.registry;
    this.auditLog = options.auditLog ?? new McpAuditLog();
    this.onToolsCall = options.onToolsCall;
    this.onOpenLink = options.onOpenLink;
    this.onMessage = options.onMessage;
    this.onModelContext = options.onModelContext;
    this.onConsentRequested = options.onConsentRequested;
    this.consentTtlMs = Math.max(10_000, options.consentTtlMs ?? 5 * 60_000);
  }

  /** Số session đang mở. */
  get size(): number {
    return this.sessions.size;
  }

  /** Tạo session bridge cho một app vừa mở. */
  createSession(options: UiBridgeV14SessionOptions): string {
    if (this.sessions.size >= UI_V14_BRIDGE_MAX_SESSIONS) {
      throw new UiBridgeV14Error(
        `Bridge v14 đã đầy (${UI_V14_BRIDGE_MAX_SESSIONS} session).`,
        'ui-v14-bridge-full',
      );
    }
    this.sessionSeq += 1;
    const sessionId = `ui-v14-${this.now()}-${this.sessionSeq}`;
    const nowMs = this.now();
    const allowedTools = new Set(options.allowedTools ?? []);
    const state: V14SessionState = {
      sessionId,
      appUri: options.appUri,
      expectedOrigin: options.expectedOrigin ?? UI_V14_SRCDOC_ORIGIN,
      allowedTools,
      autoApproveTools: new Set(options.autoApproveTools ?? []),
      allowedResourceUris: new Set(options.allowedResourceUris ?? [options.appUri]),
      allowOpenLink: options.allowOpenLink ?? false,
      hostContext: options.hostContext ?? buildDefaultHostContext(),
      initialized: false,
      ready: false,
      modelContext: {},
      createdAtMs: nowMs,
      lastSeenAtMs: nowMs,
      messagesHandled: 0,
      messagesRejected: 0,
      windowStartMs: nowMs,
      windowCount: 0,
    };
    this.sessions.set(sessionId, state);
    return sessionId;
  }

  /** Snapshot một session. */
  getSession(sessionId: string): UiBridgeV14SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      appUri: s.appUri,
      expectedOrigin: s.expectedOrigin,
      initialized: s.initialized,
      ready: s.ready,
      allowedTools: [...s.allowedTools],
      modelContext: { ...s.modelContext },
      createdAtMs: s.createdAtMs,
      lastSeenAtMs: s.lastSeenAtMs,
      messagesHandled: s.messagesHandled,
      messagesRejected: s.messagesRejected,
    };
  }

  listSessions(): UiBridgeV14SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => this.getSession(s.sessionId)!);
  }

  /** Đóng session (app đóng / unmount). */
  closeSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    for (const [id, c] of [...this.consents]) {
      if (c.sessionId === sessionId && c.status === 'pending') {
        c.status = 'expired';
        c.decidedAtMs = this.now();
        this.consents.delete(id);
      }
    }
    return existed;
  }

  /**
   * Xử lý một event postMessage từ view. Chấp nhận cả message đơn
   * lẫn batch (array). Trả response (hoặc mảng response), hoặc null
   * khi message chỉ là notification / đã bị drop hoàn toàn.
   * `tools/call` là async — caller phải await.
   */
  async handlePostMessage(
    sessionId: string,
    origin: unknown,
    data: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // Origin check trước mọi thứ — sai origin thì drop im lặng
    // (không lộ gì cho kẻ gửi lạ) nhưng vẫn ghi audit.
    if (!isAllowedV14Origin(origin, session.expectedOrigin)) {
      session.messagesRejected += 1;
      this.recordAction(session, 'postMessage', {
        outcome: 'dropped',
        detail: `Origin không được phép: ${typeof origin === 'string' ? origin : typeof origin}.`,
      });
      return null;
    }
    session.lastSeenAtMs = this.now();
    // Rate limit: quá 600 message/phút thì từ chối, không xử lý.
    if (this.now() - session.windowStartMs >= 60_000) {
      session.windowStartMs = this.now();
      session.windowCount = 0;
    }
    session.windowCount += 1;
    if (session.windowCount > UI_V14_BRIDGE_MAX_MESSAGES_PER_MINUTE) {
      session.messagesRejected += 1;
      return uiJsonRpcError(
        null,
        UI_V14_ERROR_CODES.rateLimited,
        'App gửi quá nhiều message — bị giới hạn tốc độ, thử lại sau.',
      );
    }
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

  /** Notification host → view: model context mới. */
  buildModelContextNotification(sessionId: string, context: UiModelContext): JsonRpcRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.modelContext = { ...session.modelContext, ...context };
    return uiJsonRpcNotification('ui/model-context-updated', {
      modelContext: session.modelContext,
    });
  }

  /** Notification host → view: host context mới (theme/locale đổi). */
  buildHostContextNotification(sessionId: string, patch: Partial<UiHostContext>): JsonRpcRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.hostContext = { ...session.hostContext, ...patch };
    // 'ui/host-context-updated' là notification riêng của v14 (không nằm
    // trong UI_DIALECT_HOST_NOTIFICATIONS của v13) nên build tay.
    return {
      jsonrpc: '2.0',
      method: 'ui/host-context-updated',
      params: { hostContext: session.hostContext },
    };
  }

  // -- consent ---------------------------------------------------------------

  /** Tạo (hoặc trả lại) yêu cầu consent đang chờ cho một action. */
  requestConsent(
    sessionId: string,
    action: string,
    argsSummary: string,
  ): UiV14ConsentRequest {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new UiBridgeV14Error(`Không có session "${sessionId}".`, 'ui-v14-unknown-session');
    }
    // Consent đang chờ cho cùng action thì trả lại (không tạo trùng).
    for (const c of this.consents.values()) {
      if (c.sessionId === sessionId && c.action === action && c.status === 'pending') {
        return c;
      }
    }
    if ([...this.consents.values()].filter((c) => c.status === 'pending').length >= UI_V14_MAX_PENDING_CONSENTS) {
      throw new UiBridgeV14Error('Quá nhiều consent đang chờ.', 'ui-v14-consent-full');
    }
    this.consentSeq += 1;
    const consent: UiV14ConsentRequest = {
      consentId: `consent-v14-${this.now()}-${this.consentSeq}`,
      sessionId,
      appUri: session.appUri,
      action,
      argsSummary: argsSummary.slice(0, 500),
      status: 'pending',
      requestedAtMs: this.now(),
    };
    this.consents.set(consent.consentId, consent);
    this.onConsentRequested?.(consent);
    return consent;
  }

  /** User duyệt / từ chối một consent. Trả false khi consent không còn chờ. */
  decideConsent(
    consentId: string,
    approved: boolean,
    decidedBy = 'user',
  ): boolean {
    const consent = this.consents.get(consentId);
    if (!consent || consent.status !== 'pending') return false;
    if (this.now() - consent.requestedAtMs > this.consentTtlMs) {
      consent.status = 'expired';
      consent.decidedAtMs = this.now();
      return false;
    }
    consent.status = approved ? 'approved' : 'denied';
    consent.decidedAtMs = this.now();
    consent.decidedBy = decidedBy;
    const session = this.sessions.get(consent.sessionId);
    if (session) {
      this.recordAction(session, consent.action, {
        outcome: approved ? 'ok' : 'denied',
        detail: `Consent ${approved ? 'đã duyệt' : 'đã từ chối'} bởi ${decidedBy}.`,
        consentId,
      });
    }
    return true;
  }

  /** Consent đang chờ (để panel/UI hiện hộp consent). */
  listPendingConsents(sessionId?: string): UiV14ConsentRequest[] {
    this.pruneExpiredConsents();
    return [...this.consents.values()]
      .filter(
        (c) =>
          c.status === 'pending' &&
          (sessionId === undefined || c.sessionId === sessionId),
      )
      .sort((a, b) => a.requestedAtMs - b.requestedAtMs);
  }

  getConsent(consentId: string): UiV14ConsentRequest | undefined {
    return this.consents.get(consentId);
  }

  /** True khi action đã có consent approved còn hiệu lực trong phiên. */
  hasApprovedConsent(sessionId: string, action: string): boolean {
    for (const c of this.consents.values()) {
      if (c.sessionId === sessionId && c.action === action && c.status === 'approved') {
        return true;
      }
    }
    return false;
  }

  // -- audit -----------------------------------------------------------------

  /** Log action của UI (bản sao nhẹ cho panel). */
  listActions(filter: { sessionId?: string; appUri?: string; outcome?: UiV14ActionLogEntry['outcome']; limit?: number } = {}): UiV14ActionLogEntry[] {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    return this.actionLog
      .filter(
        (e) =>
          (filter.sessionId === undefined || e.sessionId === filter.sessionId) &&
          (filter.appUri === undefined || e.appUri === filter.appUri) &&
          (filter.outcome === undefined || e.outcome === filter.outcome),
      )
      .slice(-limit)
      .reverse();
  }

  /** Audit log đầy đủ (hash chain) — để panel/export dùng chung. */
  auditEntries(): McpAuditEntry[] {
    return this.auditLog.all();
  }

  // -- nội bộ ---------------------------------------------------------------

  private pruneExpiredConsents(): void {
    const nowMs = this.now();
    for (const [id, c] of [...this.consents]) {
      if (c.status === 'pending' && nowMs - c.requestedAtMs > this.consentTtlMs) {
        c.status = 'expired';
        c.decidedAtMs = nowMs;
      }
    }
  }

  private recordAction(
    session: V14SessionState,
    method: string,
    opts: { outcome: UiV14ActionLogEntry['outcome']; detail: string; tool?: string; consentId?: string },
  ): void {
    this.actionSeq += 1;
    this.actionLog.push({
      seq: this.actionSeq,
      atMs: this.now(),
      sessionId: session.sessionId,
      appUri: session.appUri,
      method,
      ...(opts.tool ? { tool: opts.tool } : {}),
      outcome: opts.outcome,
      detail: opts.detail,
      ...(opts.consentId ? { consentId: opts.consentId } : {}),
    });
    if (this.actionLog.length > UI_V14_MAX_ACTION_LOG) {
      this.actionLog.splice(0, this.actionLog.length - UI_V14_MAX_ACTION_LOG);
    }
    // Ghi vào audit log hash-chain (args đã redact sẵn ở đây — chỉ
    // ghi summary, không ghi argument thô của UI).
    try {
      this.auditLog.record({
        direction: 'client',
        server: 'mcp-apps-v14',
        method,
        ...(opts.tool ? { tool: opts.tool } : {}),
        caller: `ui:${session.appUri}`,
        sessionId: session.sessionId,
        resultSummary: opts.detail.slice(0, 500),
        outcome:
          opts.outcome === 'ok'
            ? 'ok'
            : opts.outcome === 'denied'
              ? 'cancelled'
              : 'error',
        durationMs: 0,
      });
    } catch {
      // Audit log lỗi không được chặn bridge — action đã ghi ở bản sao nhẹ.
    }
  }

  private async handleSingle(
    session: V14SessionState,
    data: unknown,
  ): Promise<JsonRpcResponse | null> {
    const validation = validateV14BridgeMessage(data);
    if (!validation.ok || !validation.message) {
      session.messagesRejected += 1;
      this.recordAction(session, 'postMessage', {
        outcome: 'dropped',
        detail: validation.errorMessage ?? 'Message sai định dạng.',
      });
      return uiJsonRpcError(
        null,
        validation.errorCode ?? UI_JSONRPC_ERROR_CODES.invalidRequest,
        validation.errorMessage ?? 'Invalid request.',
      );
    }
    const msg = validation.message;
    session.messagesHandled += 1;
    const isNotification = msg.id === undefined;

    // Mọi method trừ ui/initialize đều yêu cầu session đã initialize.
    if (msg.method !== 'ui/initialize' && !session.initialized) {
      session.messagesRejected += 1;
      this.recordAction(session, msg.method, {
        outcome: 'denied',
        detail: 'Session chưa initialize.',
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_V14_ERROR_CODES.notInitialized,
        'Session chưa initialize — gọi ui/initialize trước.',
      );
    }

    switch (msg.method) {
      case 'ui/initialize': {
        session.initialized = true;
        session.lastSeenAtMs = this.now();
        this.recordAction(session, msg.method, { outcome: 'ok', detail: 'Session đã initialize.' });
        if (isNotification) return null;
        return uiJsonRpcResult(
          msg.id!,
          buildUiInitializeResult(session.sessionId, session.hostContext),
        );
      }
      case 'ui/ready': {
        session.ready = true;
        this.recordAction(session, msg.method, { outcome: 'ok', detail: 'App đã mount xong.' });
        return null;
      }
      case 'ui/update-model-context': {
        const context = msg.params['modelContext'];
        if (!isRecord(context)) {
          if (isNotification) return null;
          return uiJsonRpcError(
            msg.id!,
            UI_JSONRPC_ERROR_CODES.invalidParams,
            'ui/update-model-context cần params.modelContext là object.',
          );
        }
        session.modelContext = { ...session.modelContext, ...context };
        this.onModelContext?.(session.sessionId, session.modelContext);
        this.recordAction(session, msg.method, { outcome: 'ok', detail: 'Model context đã cập nhật.' });
        if (isNotification) return null;
        return uiJsonRpcResult(msg.id!, { ok: true });
      }
      case 'ui/message': {
        const levelRaw = msg.params['level'];
        const level = levelRaw === 'warn' || levelRaw === 'error' ? levelRaw : 'info';
        const text = asNonEmptyString(msg.params['message']) ?? '';
        this.onMessage?.(session.sessionId, text, level);
        this.recordAction(session, msg.method, {
          outcome: 'ok',
          detail: `[${level}] ${text.slice(0, 200)}`,
        });
        return null;
      }
      case 'ui/telemetry': {
        // Telemetry chỉ ghi nhận, không chứa PII — host không lưu
        // payload thô, chỉ đếm + ghi audit tóm tắt.
        const event = asNonEmptyString(msg.params['event']) ?? 'unknown';
        this.recordAction(session, msg.method, {
          outcome: 'ok',
          detail: `Telemetry: ${event}.`,
        });
        return null;
      }
      case 'tools/call': {
        return this.handleToolsCall(session, msg);
      }
      case 'resources/read': {
        return this.handleResourcesRead(session, msg);
      }
      case 'ui/open-link': {
        return this.handleOpenLink(session, msg);
      }
      case 'ui/close': {
        this.recordAction(session, msg.method, { outcome: 'ok', detail: 'App xin đóng.' });
        if (isNotification) return null;
        return uiJsonRpcResult(msg.id!, { ok: true, shouldClose: true });
      }
      case 'ui/set-display-mode': {
        const mode = msg.params['mode'];
        if (
          typeof mode !== 'string' ||
          !['inline', 'fullscreen', 'pip'].includes(mode)
        ) {
          if (isNotification) return null;
          return uiJsonRpcError(
            msg.id!,
            UI_JSONRPC_ERROR_CODES.invalidParams,
            'ui/set-display-mode cần params.mode là inline/fullscreen/pip.',
          );
        }
        this.recordAction(session, msg.method, {
          outcome: 'ok',
          detail: `App xin đổi display mode sang ${mode} (host quyết định cuối).`,
        });
        if (isNotification) return null;
        return uiJsonRpcResult(msg.id!, { ok: true, requestedMode: mode });
      }
      default: {
        if (isNotification) return null;
        return uiJsonRpcError(
          msg.id!,
          UI_JSONRPC_ERROR_CODES.methodNotFound,
          `Method "${msg.method}" không được hỗ trợ.`,
        );
      }
    }
  }

  private async handleToolsCall(
    session: V14SessionState,
    msg: V14BridgeMessage,
  ): Promise<JsonRpcResponse | null> {
    const isNotification = msg.id === undefined;
    const toolName = asNonEmptyString(msg.params['name']) ?? asNonEmptyString(msg.params['tool']);
    if (!toolName) {
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_JSONRPC_ERROR_CODES.invalidParams,
        'tools/call cần params.name là tên tool.',
      );
    }
    const args = isRecord(msg.params['arguments']) ? (msg.params['arguments'] as Record<string, unknown>) : {};
    // 1) Tool có nằm trong allow-list của session không?
    if (!session.allowedTools.has(toolName)) {
      session.messagesRejected += 1;
      this.recordAction(session, 'tools/call', {
        outcome: 'denied',
        detail: `Tool "${toolName}" không nằm trong allow-list của app.`,
        tool: toolName,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_V14_ERROR_CODES.forbidden,
        `Tool "${toolName}" không được phép gọi từ app này.`,
      );
    }
    // 2) Consent — trừ tool auto-approve hoặc đã có consent approved.
    const actionKey = `tools/call:${toolName}`;
    const autoApproved = session.autoApproveTools.has(toolName);
    if (!autoApproved && !this.hasApprovedConsent(session.sessionId, actionKey)) {
      const consent = this.requestConsent(
        session.sessionId,
        actionKey,
        `${toolName}(${JSON.stringify(args).slice(0, 200)})`,
      );
      this.recordAction(session, 'tools/call', {
        outcome: 'consent-required',
        detail: `Chờ consent để gọi tool "${toolName}".`,
        tool: toolName,
        consentId: consent.consentId,
      });
      if (isNotification) return null;
      return uiJsonRpcError(msg.id!, UI_V14_ERROR_CODES.consentRequired, 'Cần user duyệt trước khi gọi tool từ UI.', {
        consentId: consent.consentId,
        tool: toolName,
      });
    }
    // 3) Thực thi qua cùng đường handler như tool call trực tiếp.
    if (!this.onToolsCall) {
      this.recordAction(session, 'tools/call', {
        outcome: 'error',
        detail: `Host không có handler tools/call cho tool "${toolName}".`,
        tool: toolName,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_JSONRPC_ERROR_CODES.internalError,
        'Host chưa cấu hình handler tools/call.',
      );
    }
    try {
      const result = await this.onToolsCall(session.sessionId, toolName, args);
      this.recordAction(session, 'tools/call', {
        outcome: 'ok',
        detail: `Đã gọi tool "${toolName}" từ UI.`,
        tool: toolName,
      });
      if (isNotification) return null;
      return uiJsonRpcResult(msg.id!, { ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordAction(session, 'tools/call', {
        outcome: 'error',
        detail: `Tool "${toolName}" lỗi: ${message.slice(0, 200)}`,
        tool: toolName,
      });
      if (isNotification) return null;
      return uiJsonRpcError(msg.id!, UI_JSONRPC_ERROR_CODES.internalError, message);
    }
  }

  private handleResourcesRead(
    session: V14SessionState,
    msg: V14BridgeMessage,
  ): JsonRpcResponse | null {
    const isNotification = msg.id === undefined;
    const uri = asNonEmptyString(msg.params['uri']);
    if (!uri) {
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_JSONRPC_ERROR_CODES.invalidParams,
        'resources/read cần params.uri.',
      );
    }
    if (!uri.startsWith('ui://')) {
      this.recordAction(session, 'resources/read', {
        outcome: 'denied',
        detail: `Chỉ được đọc resource ui://, nhận "${uri}".`,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_V14_ERROR_CODES.forbidden,
        'resources/read từ UI chỉ được đọc resource ui://.',
      );
    }
    if (!session.allowedResourceUris.has(uri)) {
      this.recordAction(session, 'resources/read', {
        outcome: 'denied',
        detail: `Resource ${uri} không nằm trong allow-list của session.`,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_V14_ERROR_CODES.forbidden,
        `Resource ${uri} không được phép đọc từ app này.`,
      );
    }
    const entry = this.registry?.resolveResource(uri);
    if (!entry) {
      this.recordAction(session, 'resources/read', {
        outcome: 'error',
        detail: `Resource ${uri} chưa đăng ký.`,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_JSONRPC_ERROR_CODES.internalError,
        `Resource ${uri} chưa đăng ký.`,
      );
    }
    this.recordAction(session, 'resources/read', {
      outcome: 'ok',
      detail: `Đã đọc resource ${uri} (${entry.sizeBytes} bytes).`,
    });
    if (isNotification) return null;
    // Không trả HTML thô qua bridge response? Trả metadata + text —
    // HTML đã nằm trong iframe rồi; đọc lại chỉ để view xác nhận
    // version. Trả title/mime/version, không trả lại toàn bộ HTML
    // để tránh khuếch đại payload qua postMessage.
    return uiJsonRpcResult(msg.id!, {
      ok: true,
      uri: entry.uri,
      mimeType: entry.mimeType,
      title: entry.title,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
    });
  }

  private async handleOpenLink(
    session: V14SessionState,
    msg: V14BridgeMessage,
  ): Promise<JsonRpcResponse | null> {
    const isNotification = msg.id === undefined;
    const url = asNonEmptyString(msg.params['url']);
    if (!url || !/^https?:\/\//i.test(url)) {
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_JSONRPC_ERROR_CODES.invalidParams,
        'ui/open-link cần params.url là http(s) URL.',
      );
    }
    if (!session.allowOpenLink) {
      this.recordAction(session, 'ui/open-link', {
        outcome: 'denied',
        detail: `Mở link bị chặn (session không cho mở link): ${url.slice(0, 120)}`,
      });
      if (isNotification) return null;
      return uiJsonRpcError(
        msg.id!,
        UI_V14_ERROR_CODES.forbidden,
        'App này không được phép mở link ngoài.',
      );
    }
    let allowed = false;
    try {
      allowed = this.onOpenLink ? await this.onOpenLink(session.sessionId, url) : false;
    } catch {
      allowed = false;
    }
    this.recordAction(session, 'ui/open-link', {
      outcome: allowed ? 'ok' : 'denied',
      detail: allowed ? `Đã duyệt mở link: ${url.slice(0, 120)}` : `Từ chối mở link: ${url.slice(0, 120)}`,
    });
    if (isNotification) return null;
    return uiJsonRpcResult(msg.id!, { ok: true, allowed });
  }
}
