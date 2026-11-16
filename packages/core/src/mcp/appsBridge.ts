/**
 * MCP Apps — host-side message bridge (v1.09, Team T3).
 *
 * `apps.ts` chỉ có `parseAppBridgeMessage` — parse một message đơn lẻ
 * với 4 action (`tool-call` / `notify` / `close` / `get-data`). Module
 * này là phía host ĐẦY ĐỦ của cầu nối postMessage giữa app (chạy trong
 * sandboxed iframe, opaque origin) và host:
 *
 *   - Session: mỗi app mở được cấp một session id + nonce bí mật
 *     (host sinh, đưa vào HTML qua `window.__OPENBOT_APP_SESSION__`
 *     trước khi render — xem `appsLive.ts`); mọi message inbound phải
 *     mang đúng session id + nonce, nếu không bị drop + log.
 *   - Origin: iframe srcdoc sandbox có origin opaque (`"null"`); host
 *     chỉ chấp nhận origin `"null"` hoặc origin rỗng từ đúng frame đã
 *     đăng ký — mọi origin khác (vd app cố điều hướng sang https) bị
 *     chặn. Không bao giờ chấp nhận `"*"`.
 *   - Allowlist message type: `app-ready`, `app-request` (tool-call /
 *     notify / close / get-data / link-open), `app-progress`,
 *     `app-error`. Mọi type khác bị drop.
 *   - Request/response: message `app-request` có `requestId` thì host
 *     trả `app-response` tương ứng; timeout cấu hình được; request
 *     không có response sau timeout được đánh dấu failed trong log.
 *   - Rate limit: tối đa N message / giây / app (mặc định 20); vượt
 *     thì app bị "throttled" — message thừa bị drop + ghi log, app
 *     không bị kill (tránh một app lỗi làm sập host).
 *   - Audit log: mọi message qua lại (cả bị drop) được ghi vào log
 *     có giới hạn (ring buffer), kèm lý do drop — phục vụ
 *     McpAppSecurityReview và debug. Log không chứa payload đầy đủ
 *     quá giới hạn (cắt 2 KB) để không rò rỉ dữ liệu lớn.
 *   - Tool-call qua bridge: app chỉ được gọi tool khi template của
 *     nó khai báo action `tool-call` được phép (xem `appsV2.ts`
 *     `appActionAllowed`); host kiểm tra thêm allowlist tool name
 *     của session; tool-call bị từ chối trả `app-response` lỗi rõ ràng.
 *
 * Module này KHÔNG chạm DOM / iframe thật — nó là state machine
 * thuần, renderer (`McpAppFrame.tsx`) nối `window.addEventListener
 * ('message')` vào đây. Nhờ vậy toàn bộ logic bảo mật test được
 * bằng node:test mà không cần Electron.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import { parseAppBridgeMessage } from './apps';

/** Các type message app -> host được phép. */
export const APP_BRIDGE_INBOUND_TYPES = [
  'app-ready',
  'app-request',
  'app-progress',
  'app-error',
] as const;
export type AppBridgeInboundType = (typeof APP_BRIDGE_INBOUND_TYPES)[number];

/** Các type message host -> app. */
export const APP_BRIDGE_OUTBOUND_TYPES = [
  'app-response',
  'app-data',
  'app-status',
  'app-close',
] as const;
export type AppBridgeOutboundType = (typeof APP_BRIDGE_OUTBOUND_TYPES)[number];

/** Action trong `app-request` (mở rộng từ 4 action của `apps.ts`). */
export const APP_BRIDGE_REQUEST_ACTIONS = [
  'tool-call',
  'notify',
  'close',
  'get-data',
  'link-open',
  'form-submit',
] as const;
export type AppBridgeRequestAction = (typeof APP_BRIDGE_REQUEST_ACTIONS)[number];

/** Origin hợp lệ của iframe srcdoc sandbox (opaque origin). */
export const APP_BRIDGE_ALLOWED_ORIGINS = ['null', ''] as const;

/** Tối đa message/giây/app trước khi throttle. */
export const APP_BRIDGE_DEFAULT_RATE_LIMIT_PER_SEC = 20;
/** Cửa sổ đo rate limit (ms). */
export const APP_BRIDGE_RATE_WINDOW_MS = 1000;
/** Timeout mặc định chờ host xử lý một request (ms). */
export const APP_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Số entry tối đa trong audit log (ring buffer). */
export const APP_BRIDGE_MAX_LOG_ENTRIES = 500;
/** Payload tối đa lưu trong log entry (ký tự, sau JSON.stringify). */
export const APP_BRIDGE_MAX_LOG_PAYLOAD_CHARS = 2048;
/** Số session app tối đa cùng lúc (khớp MAX_OPEN_APPS = 10, cộng dự phòng). */
export const APP_BRIDGE_MAX_SESSIONS = 16;

export class AppBridgeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppBridgeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Sinh nonce ngẫu nhiên cho session (không dùng cho crypto, chỉ chống đoán). */
export function generateAppSessionNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  // crypto.getRandomValues có sẵn cả ở Node lẫn renderer; fallback Math.random.
  const buf = new Uint8Array(24);
  const cryptoObj =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function'
      ? globalThis.crypto
      : undefined;
  if (cryptoObj) {
    cryptoObj.getRandomValues(buf);
    for (const b of buf) out += chars[b % chars.length];
  } else {
    for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Một message app -> host đã parse + validate xong. */
export interface AppBridgeInbound {
  type: AppBridgeInboundType;
  sessionId: string;
  /** requestId khi app chờ response (chỉ `app-request`). */
  requestId?: string;
  action?: AppBridgeRequestAction;
  payload?: Record<string, unknown>;
  /** Tiến độ 0..100 (chỉ `app-progress`). */
  progress?: number;
  /** Thông báo trạng thái / lỗi. */
  message?: string;
}

/** Một message host -> app (host tự build, renderer postMessage). */
export interface AppBridgeOutbound {
  type: AppBridgeOutboundType;
  sessionId: string;
  requestId?: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

/** Một entry trong audit log của bridge. */
export interface AppBridgeLogEntry {
  seq: number;
  atMs: number;
  direction: 'in' | 'out';
  sessionId: string;
  type: string;
  /** 'accepted' | lý do drop / lỗi. */
  outcome: string;
  /** Payload rút gọn (đã cắt). */
  payloadPreview?: string;
}

/** Lý do drop một message inbound. */
export type AppBridgeDropReason =
  | 'unknown-session'
  | 'bad-nonce'
  | 'bad-origin'
  | 'unknown-type'
  | 'bad-shape'
  | 'action-not-allowed'
  | 'tool-not-allowed'
  | 'rate-limited'
  | 'session-closed';

/** Kết quả xử lý một message inbound. */
export type AppBridgeHandleResult =
  | { accepted: true; inbound: AppBridgeInbound }
  | { accepted: false; reason: AppBridgeDropReason; detail: string };

/** Tuỳ chọn cho một session app. */
export interface AppBridgeSessionOptions {
  /** App URI (vd `ui://server/app`), để log + hiển thị. */
  uri: string;
  /** Tên tool đã tạo ra app. */
  toolName?: string;
  /** Tên MCP server sở hữu app. */
  serverName?: string;
  /** Tool mà app được phép gọi qua bridge (rỗng = không được gọi tool nào). */
  allowedTools?: readonly string[];
  /** Action `app-request` được phép (mặc định: tool-call/notify/close/get-data). */
  allowedActions?: readonly AppBridgeRequestAction[];
  /** Rate limit riêng cho session (message/giây). */
  rateLimitPerSec?: number;
  /** Timeout chờ response cho request có requestId (ms). */
  requestTimeoutMs?: number;
}

/** Trạng thái một session app đang mở. */
export interface AppBridgeSessionSnapshot {
  sessionId: string;
  uri: string;
  toolName?: string;
  serverName?: string;
  nonce: string;
  createdAtMs: number;
  lastMessageAtMs: number;
  messagesIn: number;
  messagesOut: number;
  dropped: number;
  throttled: boolean;
  closed: boolean;
  ready: boolean;
}

interface SessionState extends AppBridgeSessionOptions {
  sessionId: string;
  nonce: string;
  createdAtMs: number;
  lastMessageAtMs: number;
  messagesIn: number;
  messagesOut: number;
  dropped: number;
  throttled: boolean;
  closed: boolean;
  ready: boolean;
  /** Timestamp các message trong cửa sổ rate-limit hiện tại. */
  windowStamps: number[];
  /** requestId đang chờ response -> timeout timer. */
  pending: Map<string, ReturnType<typeof setTimeout>>;
}

/** Tuỳ chọn cho AppBridgeHost. */
export interface AppBridgeHostOptions {
  now?: () => number;
  maxSessions?: number;
  maxLogEntries?: number;
  /** Rate limit mặc định cho session mới (message/giây). */
  defaultRateLimitPerSec?: number;
  /** Callback khi một tool-call qua bridge được chấp nhận (host thực thi). */
  onToolCall?: (sessionId: string, toolName: string, args: Record<string, unknown>) => void;
  /** Callback khi app yêu cầu đóng (host đóng frame). */
  onCloseRequest?: (sessionId: string) => void;
  /** Callback khi app gửi notify (host hiện toast/log). */
  onNotify?: (sessionId: string, message: string) => void;
  /** Callback khi app yêu cầu mở link ngoài (host quyết định mở hay chặn). */
  onLinkOpen?: (sessionId: string, url: string) => boolean;
}

/**
 * Host-side dispatcher cho cầu nối postMessage của MCP Apps.
 * Renderer tạo một instance cho toàn bộ desktop, đăng ký session
 * mỗi khi mở app, và gọi `handleMessage(eventOrigin, data)` cho
 * mỗi `message` event tới từ iframe.
 */
export class AppBridgeHost {
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxLogEntries: number;
  private readonly defaultRateLimitPerSec: number;
  private readonly onToolCall?: AppBridgeHostOptions['onToolCall'];
  private readonly onCloseRequest?: AppBridgeHostOptions['onCloseRequest'];
  private readonly onNotify?: AppBridgeHostOptions['onNotify'];
  private readonly onLinkOpen?: AppBridgeHostOptions['onLinkOpen'];
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: AppBridgeLogEntry[] = [];
  private seq = 0;
  private sessionCounter = 0;

  constructor(options: AppBridgeHostOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = Math.max(1, options.maxSessions ?? APP_BRIDGE_MAX_SESSIONS);
    this.maxLogEntries = Math.max(10, options.maxLogEntries ?? APP_BRIDGE_MAX_LOG_ENTRIES);
    this.defaultRateLimitPerSec = options.defaultRateLimitPerSec ?? APP_BRIDGE_DEFAULT_RATE_LIMIT_PER_SEC;
    this.onToolCall = options.onToolCall;
    this.onCloseRequest = options.onCloseRequest;
    this.onNotify = options.onNotify;
    this.onLinkOpen = options.onLinkOpen;
  }

  /** Số session đang mở. */
  get size(): number {
    return this.sessions.size;
  }

  /** Đăng ký một app mới; trả sessionId + nonce để inject vào HTML. */
  registerSession(options: AppBridgeSessionOptions): { sessionId: string; nonce: string } {
    if (this.sessions.size >= this.maxSessions) {
      throw new AppBridgeError(
        `App bridge: đã mở tối đa ${this.maxSessions} app cùng lúc`,
        'max-sessions',
      );
    }
    this.sessionCounter += 1;
    const sessionId = `app-${this.now()}-${this.sessionCounter}`;
    const nonce = generateAppSessionNonce();
    const state: SessionState = {
      ...options,
      sessionId,
      nonce,
      createdAtMs: this.now(),
      lastMessageAtMs: this.now(),
      messagesIn: 0,
      messagesOut: 0,
      dropped: 0,
      throttled: false,
      closed: false,
      ready: false,
      windowStamps: [],
      pending: new Map(),
      allowedActions: options.allowedActions ?? ['tool-call', 'notify', 'close', 'get-data'],
      rateLimitPerSec:
        options.rateLimitPerSec ?? this.defaultRateLimitPerSec,
      requestTimeoutMs:
        options.requestTimeoutMs ?? APP_BRIDGE_DEFAULT_REQUEST_TIMEOUT_MS,
    };
    this.sessions.set(sessionId, state);
    this.pushLog('out', sessionId, 'session-register', 'accepted');
    return { sessionId, nonce };
  }

  /** Đóng session: huỷ mọi pending request, không nhận message nữa. */
  closeSession(sessionId: string, reason = 'closed'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return false;
    session.closed = true;
    for (const timer of session.pending.values()) clearTimeout(timer);
    session.pending.clear();
    this.pushLog('out', sessionId, 'session-close', reason);
    this.sessions.delete(sessionId);
    return true;
  }

  /** Snapshot một session (không lộ pending timers). */
  getSession(sessionId: string): AppBridgeSessionSnapshot | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      uri: s.uri,
      toolName: s.toolName,
      serverName: s.serverName,
      nonce: s.nonce,
      createdAtMs: s.createdAtMs,
      lastMessageAtMs: s.lastMessageAtMs,
      messagesIn: s.messagesIn,
      messagesOut: s.messagesOut,
      dropped: s.dropped,
      throttled: s.throttled,
      closed: s.closed,
      ready: s.ready,
    };
  }

  /** Toàn bộ session đang mở (snapshot). */
  listSessions(): AppBridgeSessionSnapshot[] {
    return [...this.sessions.values()].map((s) => this.getSession(s.sessionId)!);
  }

  /**
   * Xử lý một message inbound từ iframe.
   * `eventOrigin` là `event.origin` của MessageEvent (`"null"` cho
   * srcdoc sandbox). `data` là `event.data` (đã parse nếu là object).
   * Trả kết quả accepted/drop; host dùng `buildResponse` để trả lời
   * request có requestId, hoặc `pending` callback (onToolCall...).
   */
  handleMessage(eventOrigin: string, data: unknown): AppBridgeHandleResult {
    if (!isRecord(data)) {
      this.pushLog('in', '-', 'unknown', 'bad-shape');
      return { accepted: false, reason: 'bad-shape', detail: 'Message phải là object.' };
    }
    const sessionId = asNonEmptyString(data['sessionId']);
    const type = asNonEmptyString(data['type']);
    if (!sessionId || !type) {
      this.pushLog('in', sessionId ?? '-', type ?? 'unknown', 'bad-shape');
      return { accepted: false, reason: 'bad-shape', detail: 'Message thiếu sessionId hoặc type.' };
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      this.pushLog('in', sessionId, type, 'unknown-session');
      return { accepted: false, reason: 'unknown-session', detail: `Không có session app "${sessionId}".` };
    }
    // Origin: chỉ chấp nhận opaque origin của srcdoc sandbox.
    if (!(APP_BRIDGE_ALLOWED_ORIGINS as readonly string[]).includes(eventOrigin)) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'bad-origin');
      return { accepted: false, reason: 'bad-origin', detail: `Origin "${eventOrigin}" không được phép.` };
    }
    // Nonce: mọi message phải mang đúng nonce của session.
    if (data['nonce'] !== session.nonce) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'bad-nonce');
      return { accepted: false, reason: 'bad-nonce', detail: 'Nonce của session không khớp.' };
    }
    // Type allowlist.
    if (!(APP_BRIDGE_INBOUND_TYPES as readonly string[]).includes(type)) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'unknown-type');
      return { accepted: false, reason: 'unknown-type', detail: `Type message "${type}" không được phép.` };
    }
    // Rate limit (sliding window 1 giây).
    const nowMs = this.now();
    session.windowStamps = session.windowStamps.filter((t) => nowMs - t < APP_BRIDGE_RATE_WINDOW_MS);
    if (session.windowStamps.length >= (session.rateLimitPerSec ?? APP_BRIDGE_DEFAULT_RATE_LIMIT_PER_SEC)) {
      session.dropped += 1;
      session.throttled = true;
      this.pushLog('in', sessionId, type, 'rate-limited');
      return { accepted: false, reason: 'rate-limited', detail: 'App gửi message quá nhanh, bị giới hạn.' };
    }
    session.windowStamps.push(nowMs);
    session.throttled = false;
    session.messagesIn += 1;
    session.lastMessageAtMs = nowMs;

    if (type === 'app-ready') {
      session.ready = true;
      this.pushLog('in', sessionId, type, 'accepted');
      return { accepted: true, inbound: { type: 'app-ready', sessionId } };
    }
    if (type === 'app-progress') {
      const progress = typeof data['progress'] === 'number' ? data['progress'] : undefined;
      if (progress !== undefined && (progress < 0 || progress > 100 || !Number.isFinite(progress))) {
        session.dropped += 1;
        this.pushLog('in', sessionId, type, 'bad-shape');
        return { accepted: false, reason: 'bad-shape', detail: 'progress phải nằm trong 0..100.' };
      }
      this.pushLog('in', sessionId, type, 'accepted');
      return {
        accepted: true,
        inbound: {
          type: 'app-progress',
          sessionId,
          ...(progress !== undefined ? { progress } : {}),
          ...(asNonEmptyString(data['message']) ? { message: data['message'] as string } : {}),
        },
      };
    }
    if (type === 'app-error') {
      this.pushLog('in', sessionId, type, 'accepted');
      return {
        accepted: true,
        inbound: {
          type: 'app-error',
          sessionId,
          ...(asNonEmptyString(data['message']) ? { message: data['message'] as string } : {}),
        },
      };
    }
    // app-request: kiểm tra action + payload. `parseAppBridgeMessage`
    // của apps.ts chỉ biết 4 action legacy — link-open/form-submit
    // (mở rộng v1.09) được validate trực tiếp ở đây với cùng quy tắc
    // (action phải là string trong allowlist, payload phải là object).
    const actionRaw = data['action'];
    if (typeof actionRaw !== 'string' || !(APP_BRIDGE_REQUEST_ACTIONS as readonly string[]).includes(actionRaw)) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'bad-shape');
      return { accepted: false, reason: 'bad-shape', detail: 'app-request sai định dạng hoặc action không được phép.' };
    }
    const action = actionRaw as AppBridgeRequestAction;
    const payload = data['payload'] === undefined ? {} : data['payload'];
    if (!isRecord(payload)) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'bad-shape');
      return { accepted: false, reason: 'bad-shape', detail: 'app-request payload phải là object.' };
    }
    const allowedActions = session.allowedActions ?? [];
    if (!allowedActions.includes(action)) {
      session.dropped += 1;
      this.pushLog('in', sessionId, type, 'action-not-allowed');
      return { accepted: false, reason: 'action-not-allowed', detail: `Action "${action}" không được phép với app này.` };
    }
    const requestId = asNonEmptyString(data['requestId']);
    // tool-call: kiểm tra tool name trong allowlist của session.
    if (action === 'tool-call') {
      const toolName = asNonEmptyString(payload['tool']);
      if (!toolName || !(session.allowedTools ?? []).includes(toolName)) {
        session.dropped += 1;
        this.pushLog('in', sessionId, type, 'tool-not-allowed');
        return {
          accepted: false,
          reason: 'tool-not-allowed',
          detail: toolName ? `Tool "${toolName}" is not allowed to be called from this app.` : 'tool-call is missing a tool name.',
        };
      }
      this.pushLog('in', sessionId, type, 'accepted');
      this.onToolCall?.(sessionId, toolName, isRecord(payload['arguments']) ? payload['arguments'] : {});
      return {
        accepted: true,
        inbound: { type: 'app-request', sessionId, ...(requestId ? { requestId } : {}), action, payload },
      };
    }
    if (action === 'link-open') {
      const url = asNonEmptyString(payload['url']);
      if (!url || !/^https?:\/\//i.test(url)) {
        session.dropped += 1;
        this.pushLog('in', sessionId, type, 'bad-shape');
        return { accepted: false, reason: 'bad-shape', detail: 'link-open cần URL http(s) hợp lệ.' };
      }
      const allowed = this.onLinkOpen ? this.onLinkOpen(sessionId, url) : false;
      this.pushLog('in', sessionId, type, allowed ? 'accepted' : 'action-not-allowed');
      if (!allowed) {
        return { accepted: false, reason: 'action-not-allowed', detail: `Link "${url}" was blocked by the host.` };
      }
      return {
        accepted: true,
        inbound: { type: 'app-request', sessionId, ...(requestId ? { requestId } : {}), action, payload },
      };
    }
    if (action === 'notify') {
      const message = asNonEmptyString(payload['message']) ?? '';
      this.onNotify?.(sessionId, message);
    }
    if (action === 'close') {
      this.onCloseRequest?.(sessionId);
    }
    this.pushLog('in', sessionId, type, 'accepted');
    return {
      accepted: true,
      inbound: { type: 'app-request', sessionId, ...(requestId ? { requestId } : {}), action, payload },
    };
  }

  /**
   * Build message host -> app. Renderer postMessage cái này vào iframe
   * (targetOrigin `"*"` KHÔNG được dùng — renderer phải post vào đúng
   * `contentWindow` của frame đã đăng ký; origin check nằm ở phía app
   * qua nonce trong payload).
   */
  buildOutbound(
    sessionId: string,
    type: AppBridgeOutboundType,
    options: { requestId?: string; ok?: boolean; payload?: Record<string, unknown>; error?: string } = {},
  ): AppBridgeOutbound | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return null;
    session.messagesOut += 1;
    const out: AppBridgeOutbound = {
      type,
      sessionId,
      ok: options.ok ?? true,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.payload ? { payload: options.payload } : {}),
      ...(options.error ? { error: options.error } : {}),
    };
    this.pushLog('out', sessionId, type, 'accepted', options.payload);
    return out;
  }

  /** Response cho một app-request có requestId (ok hoặc lỗi). */
  respondToRequest(
    sessionId: string,
    requestId: string,
    result: { ok: boolean; payload?: Record<string, unknown>; error?: string },
  ): AppBridgeOutbound | null {
    return this.buildOutbound(sessionId, 'app-response', {
      requestId,
      ok: result.ok,
      ...(result.payload ? { payload: result.payload } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  /** Đẩy dữ liệu mới xuống app (live update — xem appsLive.ts). */
  pushData(sessionId: string, data: Record<string, unknown>, version: number): AppBridgeOutbound | null {
    return this.buildOutbound(sessionId, 'app-data', {
      payload: { data, version },
    });
  }

  /** Đẩy trạng thái tool call xuống app (running/progress/done/error). */
  pushStatus(
    sessionId: string,
    status: 'running' | 'progress' | 'done' | 'error',
    detail?: { progress?: number; message?: string },
  ): AppBridgeOutbound | null {
    return this.buildOutbound(sessionId, 'app-status', {
      payload: { status, ...(detail ?? {}) },
    });
  }

  /** Toàn bộ audit log (mới nhất cuối). */
  getLog(): AppBridgeLogEntry[] {
    return [...this.log];
  }

  /** Log đã lọc theo session. */
  getLogForSession(sessionId: string): AppBridgeLogEntry[] {
    return this.log.filter((e) => e.sessionId === sessionId);
  }

  /** Số message bị drop (toàn bộ host). */
  get droppedTotal(): number {
    return this.log.filter((e) => e.direction === 'in' && e.outcome !== 'accepted').length;
  }

  private pushLog(
    direction: 'in' | 'out',
    sessionId: string,
    type: string,
    outcome: string,
    payload?: unknown,
  ): void {
    this.seq += 1;
    let payloadPreview: string | undefined;
    if (payload !== undefined) {
      try {
        const text = JSON.stringify(payload);
        payloadPreview =
          text.length > APP_BRIDGE_MAX_LOG_PAYLOAD_CHARS
            ? `${text.slice(0, APP_BRIDGE_MAX_LOG_PAYLOAD_CHARS)}…(truncated)`
            : text;
      } catch {
        payloadPreview = '[unserializable]';
      }
    }
    this.log.push({ seq: this.seq, atMs: this.now(), direction, sessionId, type, outcome, ...(payloadPreview !== undefined ? { payloadPreview } : {}) });
    while (this.log.length > this.maxLogEntries) this.log.shift();
  }
}

/**
 * Parse một message inbound thô (không cần host instance) — dùng
 * trong test và trong renderer trước khi đưa vào host. Trả null khi
 * shape sai hoàn toàn; các kiểm tra session/origin/nonce vẫn do
 * `AppBridgeHost.handleMessage` thực hiện.
 */
export function parseAppBridgeInbound(data: unknown): AppBridgeInbound | null {
  if (!isRecord(data)) return null;
  const type = asNonEmptyString(data['type']);
  const sessionId = asNonEmptyString(data['sessionId']);
  if (!type || !sessionId) return null;
  if (!(APP_BRIDGE_INBOUND_TYPES as readonly string[]).includes(type)) return null;
  if (type === 'app-request') {
    const parsed = parseAppBridgeMessage({
      type: 'mcp-app-request',
      action: data['action'],
      payload: data['payload'],
    });
    if (!parsed) return null;
    return {
      type: 'app-request',
      sessionId,
      ...(asNonEmptyString(data['requestId']) ? { requestId: data['requestId'] as string } : {}),
      action: parsed.action as AppBridgeRequestAction,
      ...(parsed.payload ? { payload: parsed.payload } : {}),
    };
  }
  return {
    type: type as AppBridgeInboundType,
    sessionId,
    ...(asNonEmptyString(data['requestId']) ? { requestId: data['requestId'] as string } : {}),
    ...(typeof data['progress'] === 'number' ? { progress: data['progress'] } : {}),
    ...(asNonEmptyString(data['message']) ? { message: data['message'] as string } : {}),
  };
}
