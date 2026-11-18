/**
 * MCP Apps host v14 — orchestrator (SEP-1865 stable 2026-01-26,
 * ideas only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * Một chỗ duy nhất nối các mảnh v14 lại với nhau:
 *
 *   tool `_meta.ui` (appsUiV14 — khai báo + fallback bắt buộc)
 *     → capability negotiation với client (ui/text)
 *     → client không render được: trả TEXT FALLBACK đầy đủ
 *     → client render được: mở app qua host v13 (registry ui://,
 *       AppManager, display mode) + tạo session bridge v14
 *     → view ↔ host qua bridge postMessage `ui/*` (appsBridgeV14)
 *       với origin/method validation + consent + audit
 *     → render trong iframe sandbox CSP nghiêm (appsPreviewV14)
 *     → panel xem trước + audit log cho user review
 *
 * Phân tầng an toàn (quan trọng):
 *   - Host v13 bên dưới được tạo KHÔNG có `onToolsCall` — dialect
 *     `ui/` của v13 mặc định TỪ CHỐI `tools/call`. Đường duy nhất
 *     app gọi tool là bridge v14, nơi mọi call đều qua consent +
 *     audit. Không có đường vòng.
 *   - Text fallback là bắt buộc ở cả 2 cửa: lúc đăng ký tool
 *     (`declareToolUi`) và lúc mở app (`validateToolResult`).
 *     Client text-only không bao giờ nhận "app rỗng".
 *
 * Host không chạm DOM / network: mọi hàm trả object để renderer
 * (hoặc tool) thực thi.
 */

import { McpAppHostV13, type OpenedAppV13 } from './appsHostV13';
import { UiBridgeHostV14, type UiV14ActionLogEntry, type UiV14ConsentRequest } from './appsBridgeV14';
import { buildV14FrameConfig, McpAppsPreviewPanelV14, type V14FrameConfig, type V14SandboxAllowList, type V14AppPreview } from './appsPreviewV14';
import {
  McpAppsUiRegistryV14,
  MCP_APPS_V14_VERSION,
  negotiateAppsCapability,
  parseV14ClientCapability,
  type ToolUiRegistrationV14,
  type V14ClientAppsCapability,
  type V14NegotiationResult,
} from './appsUiV14';
import { parseToolUiMeta } from './appsUiMeta';
import type { UiHostContext, UiModelContext, JsonRpcRequest, JsonRpcResponse } from './appsUiDialect';
import { McpAuditLog } from './auditLog';

export * from './appsUiV14';
export * from './appsPreviewV14';
export * from './appsBridgeV14';

export class McpAppHostV14Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppHostV14Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Kết quả mở app cho một client (UI hoặc text fallback). */
export type OpenAppForClientResult =
  | {
      mode: 'ui';
      opened: OpenedAppV13;
      /** Session id bridge v14 — renderer dùng cho postMessage `ui/*`. */
      bridgeSessionId: string;
      /** Frame config sandbox v14 (CSP nghiêm + allow-list). */
      frameConfigV14: V14FrameConfig;
      negotiation: V14NegotiationResult;
    }
  | {
      mode: 'text';
      /** Bản text đầy đủ để client không render được vẫn thấy nội dung. */
      textFallback: string;
      negotiation: V14NegotiationResult;
    };

/** Tuỳ chọn mở app cho client. */
export interface OpenAppForClientOptions {
  /** Display mode muốn dùng (ưu tiên hơn `_meta.ui.displayMode`). */
  displayMode?: OpenedAppV13['displayMode'];
  /** Allow-list host cho CSP của app. */
  allowList?: V14SandboxAllowList;
  /** Tool app được phép gọi qua bridge (mặc định: chỉ tool tạo ra app). */
  allowedTools?: string[];
  /** Tool được auto-approve không cần consent (host cấu hình tường minh). */
  autoApproveTools?: string[];
  /** App có được mở link ngoài không (mặc định false). */
  allowOpenLink?: boolean;
  /** Origin kỳ vọng cho postMessage (mặc định 'null' — iframe srcdoc). */
  expectedOrigin?: string;
  /** Tiêu đề ghi đè. */
  title?: string;
}

export interface McpAppHostV14Options {
  now?: () => number;
  registry?: McpAppsUiRegistryV14;
  hostV13?: McpAppHostV13;
  bridge?: UiBridgeHostV14;
  panel?: McpAppsPreviewPanelV14;
  auditLog?: McpAuditLog;
  hostContext?: UiHostContext;
  /** Handler thực thi tools/call cho app (đi qua consent của bridge). */
  onToolsCall?: (sessionId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Handler quyết định mở link ngoài. */
  onOpenLink?: (sessionId: string, url: string) => boolean | Promise<boolean>;
  /** App gửi message về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** App cập nhật model context. */
  onModelContext?: (sessionId: string, context: UiModelContext) => void;
  /** Consent mới cần user quyết định. */
  onConsentRequested?: (consent: UiV14ConsentRequest) => void;
}

/**
 * Host v14 — nối registry + negotiation + host v13 + bridge v14 +
 * preview panel. Một instance cho toàn bộ desktop.
 */
export class McpAppHostV14 {
  readonly version = MCP_APPS_V14_VERSION;
  readonly registry: McpAppsUiRegistryV14;
  readonly hostV13: McpAppHostV13;
  readonly bridge: UiBridgeHostV14;
  readonly panel: McpAppsPreviewPanelV14;
  readonly auditLog: McpAuditLog;
  private readonly now: () => number;
  /** appId (v13) -> bridge sessionId (v14). */
  private readonly bridgeSessionByApp = new Map<string, string>();

  constructor(options: McpAppHostV14Options = {}) {
    this.now = options.now ?? Date.now;
    this.auditLog = options.auditLog ?? new McpAuditLog();
    this.registry = options.registry ?? new McpAppsUiRegistryV14({ now: this.now });
    // Host v13 KHÔNG có onToolsCall: dialect v13 mặc định từ chối
    // tools/call — đường duy nhất gọi tool là bridge v14 (consent).
    this.hostV13 =
      options.hostV13 ??
      new McpAppHostV13({
        now: this.now,
        registry: this.registry.inner,
        ...(options.hostContext ? { hostContext: options.hostContext } : {}),
        onMessage: options.onMessage,
        onModelContext: options.onModelContext,
      });
    this.bridge =
      options.bridge ??
      new UiBridgeHostV14({
        now: this.now,
        registry: this.registry,
        auditLog: this.auditLog,
        onToolsCall: options.onToolsCall,
        onOpenLink: options.onOpenLink,
        onMessage: options.onMessage,
        onModelContext: options.onModelContext,
        onConsentRequested: options.onConsentRequested,
      });
    this.panel =
      options.panel ??
      new McpAppsPreviewPanelV14({ now: this.now, registry: this.registry, bridge: this.bridge });
  }

  // -- đăng ký: resource / khai báo / fallback ------------------------------

  /**
   * Đăng ký resource app vào registry `ui://` (HTML đã validate,
   * MIME `text/html;profile=mcp-app`). Bước 1 trước khi khai báo tool.
   */
  registerResource(input: {
    uri: string;
    serverName?: string;
    toolName?: string;
    title?: string;
    html: string;
    mimeType?: string;
    displayMode?: 'inline' | 'fullscreen' | 'pip';
    ttlMs?: number;
  }): ReturnType<McpAppsUiRegistryV14['registerResource']> {
    return this.registry.registerResource(input);
  }

  /** Đăng ký text fallback cho một tool (bước 2a). */
  registerTextFallback(toolName: string, text: string): ReturnType<McpAppsUiRegistryV14['registerTextFallback']> {
    return this.registry.registerTextFallback(toolName, text);
  }

  /**
   * Khai báo UI cho một tool (`_meta.ui` + text fallback bắt buộc).
   * Ném lỗi khi resource chưa đăng ký hoặc thiếu fallback.
   */
  declareToolUi(
    toolName: string,
    uiMeta: unknown,
    options: { textFallback?: string; serverName?: string } = {},
  ): ToolUiRegistrationV14 {
    return this.registry.declareToolUi(toolName, uiMeta, options);
  }

  /** Liệt kê tool nào có UI (kèm trạng thái resource + fallback). */
  listUiTools(filter: { serverName?: string } = {}): ReturnType<McpAppsUiRegistryV14['listUiTools']> {
    return this.registry.listUiTools(filter);
  }

  // -- capability negotiation -------------------------------------------------

  /** Parse capability MCP Apps của client từ handshake thô. */
  parseClientCapability(handshake: unknown): V14ClientAppsCapability {
    return parseV14ClientCapability(handshake);
  }

  /** Negotiation cho một tool với capability client đã parse. */
  negotiateForTool(toolName: string, client: V14ClientAppsCapability): V14NegotiationResult {
    return this.registry.negotiateForTool(toolName, client);
  }

  // -- mở app cho client (UI hoặc text fallback) ------------------------------

  /**
   * Mở app từ kết quả `tools/call` cho một client cụ thể.
   *
   *   - Client không hỗ trợ Apps / không có render mode chung /
   *     resource chưa đăng ký / thiếu fallback → trả `{ mode:
   *     'text', textFallback }` (progressive enhancement).
   *   - Còn lại → mở app qua host v13 + tạo bridge session v14,
   *     trả `{ mode: 'ui', opened, bridgeSessionId, frameConfigV14 }`.
   *
   * Ném `McpAppHostV14Error` khi tool không khai báo UI, kết quả
   * thiếu text fallback, hoặc HTML bị chặn.
   */
  openAppForClient(
    tool: unknown,
    result: unknown,
    client: V14ClientAppsCapability,
    options: OpenAppForClientOptions = {},
  ): OpenAppForClientResult {
    const toolName = isRecord(tool) ? asNonEmptyString(tool['name']) : undefined;
    if (!toolName) {
      throw new McpAppHostV14Error('Tool thiếu tên — không mở được app.', 'host-v14-bad-tool');
    }
    const declaration = parseToolUiMeta(tool);
    if (!declaration) {
      throw new McpAppHostV14Error(
        `Tool "${toolName}" không khai báo _meta.ui — không có app để mở.`,
        'host-v14-tool-has-no-ui',
      );
    }
    const negotiation = this.registry.negotiateForTool(toolName, client);
    if (!negotiation.sendUi) {
      // Progressive enhancement xuống text: lấy text từ kết quả
      // tool, nếu không có thì lấy fallback đã đăng ký.
      let textFallback: string | undefined;
      try {
        textFallback = this.registry.validateToolResult(toolName, result).textFallback;
      } catch {
        textFallback = this.registry.getTextFallback(toolName)?.text;
      }
      if (!textFallback) {
        throw new McpAppHostV14Error(
          `Tool "${toolName}" không có text fallback để trả cho client không render được.`,
          'host-v14-no-fallback',
        );
      }
      return { mode: 'text', textFallback, negotiation };
    }
    // Cửa UI: kết quả bắt buộc phải có text fallback dùng được.
    this.registry.validateToolResult(toolName, result);
    const opened = this.hostV13.openAppFromTool(tool, result, {
      ...(options.displayMode ? { displayMode: options.displayMode } : {}),
      ...(options.title ? { title: options.title } : {}),
      allowedHosts: [
        ...(options.allowList?.scriptHosts ?? []),
        ...(options.allowList?.styleHosts ?? []),
        ...(options.allowList?.imageHosts ?? []),
        ...(options.allowList?.mediaHosts ?? []),
        ...(options.allowList?.fontHosts ?? []),
        ...(options.allowList?.connectHosts ?? []),
      ],
      allowedTools: options.allowedTools ?? [toolName],
      allowOpenLink: options.allowOpenLink ?? false,
    });
    const appDef = this.hostV13.getApp(opened.appId);
    const frameConfigV14 = buildV14FrameConfig(
      {
        uri: opened.uri,
        title: opened.title,
        html: appDef?.html ?? '',
      },
      options.allowList ?? {},
    );
    const bridgeSessionId = this.bridge.createSession({
      appUri: opened.uri,
      expectedOrigin: options.expectedOrigin ?? 'null',
      allowedTools: options.allowedTools ?? [toolName],
      ...(options.autoApproveTools ? { autoApproveTools: options.autoApproveTools } : {}),
      allowedResourceUris: [opened.uri],
      allowOpenLink: options.allowOpenLink ?? false,
      hostContext: opened.hostContext,
    });
    this.bridgeSessionByApp.set(opened.appId, bridgeSessionId);
    return { mode: 'ui', opened, bridgeSessionId, frameConfigV14, negotiation };
  }

  /**
   * Mở app đã đăng ký trong registry `ui://` theo URI cho một
   * client (UI hoặc text fallback của tool sở hữu app).
   */
  openRegisteredAppForClient(
    uri: string,
    client: V14ClientAppsCapability,
    options: OpenAppForClientOptions & { toolName?: string } = {},
  ): OpenAppForClientResult {
    const entry = this.registry.resolveResource(uri);
    if (!entry) {
      throw new McpAppHostV14Error(
        `Không có app nào đăng ký cho "${uri}".`,
        'host-v14-not-registered',
      );
    }
    const toolName = options.toolName ?? entry.toolName;
    if (!toolName) {
      throw new McpAppHostV14Error(
        `App ${uri} không gắn với tool nào — không xác định được text fallback.`,
        'host-v14-no-tool',
      );
    }
    const negotiation = this.registry.negotiateForTool(toolName, client);
    if (!negotiation.sendUi) {
      const fallback = this.registry.getTextFallback(toolName)?.text;
      if (!fallback) {
        throw new McpAppHostV14Error(
          `Tool "${toolName}" không có text fallback để trả cho client không render được.`,
          'host-v14-no-fallback',
        );
      }
      return { mode: 'text', textFallback: fallback, negotiation };
    }
    const opened = this.hostV13.openAppFromRegistry(uri, {
      ...(options.displayMode ? { displayMode: options.displayMode } : {}),
      ...(options.title ? { title: options.title } : {}),
      allowedTools: options.allowedTools ?? (toolName ? [toolName] : []),
      allowOpenLink: options.allowOpenLink ?? false,
    });
    const appDef = this.hostV13.getApp(opened.appId);
    const frameConfigV14 = buildV14FrameConfig(
      { uri: opened.uri, title: opened.title, html: appDef?.html ?? '' },
      options.allowList ?? {},
    );
    const bridgeSessionId = this.bridge.createSession({
      appUri: opened.uri,
      expectedOrigin: options.expectedOrigin ?? 'null',
      allowedTools: options.allowedTools ?? (toolName ? [toolName] : []),
      ...(options.autoApproveTools ? { autoApproveTools: options.autoApproveTools } : {}),
      allowedResourceUris: [opened.uri],
      allowOpenLink: options.allowOpenLink ?? false,
      hostContext: opened.hostContext,
    });
    this.bridgeSessionByApp.set(opened.appId, bridgeSessionId);
    return { mode: 'ui', opened, bridgeSessionId, frameConfigV14, negotiation };
  }

  // -- bridge postMessage ------------------------------------------------------

  /**
   * Xử lý một event postMessage từ view. Renderer lấy
   * `event.origin` + `event.data`, gọi hàm này, rồi postMessage
   * response trả về vào iframe.
   */
  handleUiPostMessage(
    bridgeSessionId: string,
    origin: unknown,
    data: unknown,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    return this.bridge.handlePostMessage(bridgeSessionId, origin, data);
  }

  /** Đẩy model context mới xuống app — trả notification cho renderer. */
  updateModelContext(appId: string, context: UiModelContext): JsonRpcRequest | null {
    const bridgeSessionId = this.bridgeSessionByApp.get(appId);
    if (bridgeSessionId) {
      return this.bridge.buildModelContextNotification(bridgeSessionId, context);
    }
    return this.hostV13.updateModelContext(appId, context);
  }

  /** Đóng app: gỡ khỏi host v13 + bridge v14 + panel. */
  closeApp(appId: string): boolean {
    const bridgeSessionId = this.bridgeSessionByApp.get(appId);
    if (bridgeSessionId) this.bridge.closeSession(bridgeSessionId);
    this.bridgeSessionByApp.delete(appId);
    return this.hostV13.closeApp(appId);
  }

  /** Bridge sessionId của một app đang mở. */
  bridgeSessionForApp(appId: string): string | undefined {
    return this.bridgeSessionByApp.get(appId);
  }

  // -- consent + audit + preview ----------------------------------------------

  /** User duyệt / từ chối một consent từ UI. */
  decideConsent(consentId: string, approved: boolean, decidedBy = 'user'): boolean {
    return this.bridge.decideConsent(consentId, approved, decidedBy);
  }

  /** Consent đang chờ (để UI hiện hộp consent). */
  listPendingConsents(appUri?: string): UiV14ConsentRequest[] {
    return this.panel.listPendingConsents(appUri);
  }

  /** Audit log các action từ UI (mới nhất trước). */
  listUiAudit(filter: {
    appUri?: string;
    sessionId?: string;
    outcome?: UiV14ActionLogEntry['outcome'];
    limit?: number;
  } = {}): UiV14ActionLogEntry[] {
    return this.panel.listAudit(filter);
  }

  /** Panel xem trước: liệt kê app đã đăng ký. */
  listPreviews(filter: { serverName?: string; toolName?: string } = {}): V14AppPreview[] {
    return this.panel.listPreviews(filter);
  }

  /** Xem trước một app (frame sandbox + audit + consent). */
  previewApp(uri: string, allowList: V14SandboxAllowList = {}): ReturnType<McpAppsPreviewPanelV14['previewApp']> {
    return this.panel.previewApp(uri, allowList);
  }

  /** Snapshot các app đang mở cho UI (không kèm HTML). */
  listOpenApps(): ReturnType<McpAppHostV13['listApps']> {
    return this.hostV13.listApps();
  }

  /** Negotiation thuần cho một tool — dùng khi server muốn biết trước. */
  negotiate(
    client: V14ClientAppsCapability,
    tool: { declaration: ReturnType<typeof parseToolUiMeta>; hasTextFallback: boolean; resourceRegistered: boolean },
  ): V14NegotiationResult {
    return negotiateAppsCapability(client, tool);
  }

  /** Thống kê host v14. */
  stats(): {
    version: string;
    appsOpen: number;
    registryEntries: number;
    uiTools: number;
    bridgeSessions: number;
    pendingConsents: number;
    auditActions: number;
  } {
    const panelStats = this.panel.stats();
    return {
      version: MCP_APPS_V14_VERSION,
      appsOpen: this.hostV13.stats().appsOpen,
      registryEntries: panelStats.appsRegistered,
      uiTools: panelStats.uiTools,
      bridgeSessions: panelStats.bridgeSessions,
      pendingConsents: panelStats.pendingConsents,
      auditActions: panelStats.auditActions,
    };
  }
}
