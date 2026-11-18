/**
 * MCP Apps host v15 — orchestrator (SEP-1865 stable 2026-01-26,
 * ideas only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * Một chỗ duy nhất nối các mảnh v15 lại với nhau:
 *
 *   tool `_meta.ui` (appsUiV15 — MIME profile + manifest + host
 *     context + fallback bắt buộc)
 *     → capability negotiation với client (ui/text, uỷ quyền v14)
 *     → client không render được: trả TEXT FALLBACK đầy đủ
 *     → client render được: kiểm tra open policy (manifest) rồi
 *       mở app — tạo session bridge v15 (appsBridgeV15) + consent
 *       manager v15 (appsConsentV15) cho session đó
 *     → view ↔ host qua bridge postMessage JSON-RPC 2.0:
 *       tools/call đi qua consent (read-only allowlist thì
 *       auto-approve, còn lại user duyệt); resources/read qua
 *       allowlist; ui/open-link / ui/post-message qua host quyết
 *     → kết quả tool có dữ liệu cấu trúc → auto-visualiser v15
 *       (appsVisualiserV15) sinh chart/sankey/mermaid/map + text
 *       fallback, đính kèm khi mở app
 *     → Agent Skills tạo app mới (appsSkillsV15): scaffold /
 *       migrate app rồi đăng ký vào registry v15
 *     → mọi action ghi audit (McpAuditLog, hash chain) + consent
 *       audit riêng của consent manager
 *
 * Phân tầng an toàn (quan trọng, kế thừa v14 và siết thêm):
 *   - Host KHÔNG có `onToolsCall` mặc định: app gọi tool mà host
 *     chưa cấu hình handler thì bị từ chối -32603, không có đường
 *     nào chạy tool âm thầm.
 *   - Đường duy nhất app gọi tool là bridge v15 → consent manager:
 *     tool lạ / chưa phân loại → side-effect → cần user duyệt.
 *   - Text fallback bắt buộc ở cả 2 cửa (đăng ký + mở app).
 *   - Consent nhạy cảm là one-shot: duyệt xong dùng một lần rồi
 *     vô hiệu hoá ngay.
 *
 * Host không chạm DOM / network: mọi hàm trả object để renderer
 * (hoặc tool) thực thi.
 */

import {
  McpAppsUiRegistryV15,
  MCP_APPS_V15_VERSION,
  buildHostContextV15,
  parseV14ClientCapability,
  type ToolUiRegistrationV15,
  type UiHostContextV15,
  type V14ClientAppsCapability,
  type V14NegotiationResult,
} from './appsUiV15';
import {
  UiBridgeHostV15,
  type UiBridgeV15SessionSnapshot,
} from './appsBridgeV15';
import {
  UiConsentManagerV15,
  classifyToolCallV15,
  type UiV15ConsentRequest,
} from './appsConsentV15';
import {
  AutoVisualiserV15,
  visualiseData,
  type UiV15Visualisation,
} from './appsVisualiserV15';
import { McpAppSkillsRegistryV15 } from './appsSkillsV15';
import { parseToolUiMeta } from './appsUiMeta';
import { McpAuditLog } from './auditLog';
import type { JsonRpcResponse } from './appsUiDialect';

export * from './appsUiV15';
export * from './appsBridgeV15';
export * from './appsConsentV15';
export * from './appsVisualiserV15';
export * from './appsSkillsV15';

export class McpAppHostV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppHostV15Error';
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
export type OpenAppForClientV15Result =
  | {
      mode: 'ui';
      /** ResourceUri của app đã mở. */
      appUri: string;
      /** Session id bridge v15 — renderer dùng cho postMessage. */
      bridgeSessionId: string;
      /** Host context trả cho app trong ui/initialize. */
      hostContext: UiHostContextV15;
      negotiation: V14NegotiationResult;
      /** Visualisation tự sinh từ kết quả tool (nếu có). */
      visualisation?: UiV15Visualisation;
      /** Cảnh báo open policy / manifest. */
      warnings: string[];
    }
  | {
      mode: 'text';
      /** Bản text đầy đủ để client không render được vẫn thấy nội dung. */
      textFallback: string;
      negotiation: V14NegotiationResult;
      /** Visualisation text fallback (khi kết quả có dữ liệu vẽ được). */
      visualisation?: UiV15Visualisation;
    };

/** Tuỳ chọn mở app cho client. */
export interface OpenAppForClientV15Options {
  /** Display mode muốn dùng (ưu tiên hơn `_meta.ui.displayMode`). */
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Tool app được phép gọi qua bridge (mặc định: chỉ tool tạo ra app). */
  allowedTools?: string[];
  /** Resource app được phép đọc (mặc định: chỉ resource của chính app). */
  allowedResources?: string[];
  /** Tool được auto-approve khi là read-only (ghi vào policy consent). */
  autoApproveReadOnlyTools?: string[];
  /** App có được mở link ngoài không (mặc định false). */
  allowOpenLink?: boolean;
  /** App có được post message vào chat không (mặc định false). */
  allowPostMessage?: boolean;
  /** Origin kỳ vọng cho postMessage (mặc định 'null' — iframe srcdoc). */
  expectedOrigin?: string;
  /** Tiêu đề ghi đè. */
  title?: string;
  /** Bật auto-visualiser cho kết quả tool (mặc định true). */
  autoVisualise?: boolean;
  /** Theme/locale/timezone/platform cho host context. */
  theme?: UiHostContextV15['theme'];
  locale?: string;
  timezone?: string;
  platform?: string;
}

/** Một app đang mở qua host v15. */
export interface OpenedAppV15 {
  appUri: string;
  toolName: string;
  serverName: string;
  bridgeSessionId: string;
  displayMode: 'inline' | 'fullscreen' | 'pip';
  openedAtMs: number;
  title?: string;
  visualisationKind?: string;
}

export interface McpAppHostV15Options {
  now?: () => number;
  registry?: McpAppsUiRegistryV15;
  bridge?: UiBridgeHostV15;
  consent?: UiConsentManagerV15;
  visualiser?: AutoVisualiserV15;
  skills?: McpAppSkillsRegistryV15;
  auditLog?: McpAuditLog;
  /** Handler thực thi tools/call cho app (đi qua consent của bridge). */
  onToolsCall?: (sessionId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Handler đọc resource cho app. */
  onResourcesRead?: (sessionId: string, uri: string) => Promise<unknown> | unknown;
  /** Handler quyết định mở link ngoài. */
  onOpenLink?: (sessionId: string, url: string) => boolean | Promise<boolean>;
  /** App gửi message vào chat — host quyết định có đưa vào chat không. */
  onPostMessage?: (sessionId: string, text: string) => boolean | Promise<boolean>;
  /** App gửi message hiển thị/log về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** Consent mới cần user quyết định. */
  onConsentRequested?: (consent: UiV15ConsentRequest) => void;
  /** App xin đóng chính nó. */
  onClose?: (sessionId: string) => void;
}

/**
 * Host v15 — orchestrator. Giữ registry + bridge + consent +
 * visualiser + skills + audit trong một chỗ, với luật an toàn:
 * không handler tools/call → app không gọi được tool nào.
 */
export class McpAppHostV15 {
  /** Registry v15 (resource ui:// + manifest + khai báo + fallback). */
  readonly registry: McpAppsUiRegistryV15;
  /** Bridge v15 (postMessage JSON-RPC 2.0). */
  readonly bridge: UiBridgeHostV15;
  /** Consent manager v15 (action do UI khởi xướng). */
  readonly consent: UiConsentManagerV15;
  /** Auto-visualiser v15. */
  readonly visualiser: AutoVisualiserV15;
  /** Registry Agent Skills tạo app. */
  readonly skills: McpAppSkillsRegistryV15;
  /** Audit log chung (hash chain). */
  readonly auditLog: McpAuditLog;
  private readonly now: () => number;
  private readonly options: McpAppHostV15Options;
  private readonly opened = new Map<string, OpenedAppV15>();

  constructor(options: McpAppHostV15Options = {}) {
    this.now = options.now ?? Date.now;
    this.options = options;
    this.registry = options.registry ?? new McpAppsUiRegistryV15({ now: this.now });
    this.consent = options.consent ?? new UiConsentManagerV15({ now: this.now });
    this.visualiser = options.visualiser ?? new AutoVisualiserV15();
    this.skills = options.skills ?? new McpAppSkillsRegistryV15();
    this.auditLog = options.auditLog ?? new McpAuditLog();
    const host = this;
    this.bridge =
      options.bridge ??
      new UiBridgeHostV15({
        now: this.now,
        onToolsCall: async (sessionId, toolName, args) => host.executeToolCall(sessionId, toolName, args),
        onResourcesRead: options.onResourcesRead,
        onOpenLink: options.onOpenLink,
        onPostMessage: options.onPostMessage,
        onMessage: options.onMessage,
        onClose: (sessionId) => {
          host.closeAppBySession(sessionId);
          options.onClose?.(sessionId);
        },
        onConsentRequired: (sessionId, request) => host.requireConsentForBridgeCall(sessionId, request),
        onBlocked: (sessionId, reason, method) => {
          host.auditLog.record({
            direction: 'server',
            server: 'mcp-apps-v15',
            method: method ?? 'ui/bridge',
            sessionId,
            outcome: 'error',
            errorMessage: reason,
            durationMs: 0,
          });
        },
      });
  }

  /** Version host. */
  static readonly VERSION = MCP_APPS_V15_VERSION;

  /** Số app đang mở. */
  get openAppCount(): number {
    return this.opened.size;
  }

  // -- mở app ---------------------------------------------------------------

  /**
   * Mở app của một tool cho một client (UI hoặc text fallback).
   *
   * Thứ tự (fail-closed):
   *   1. Tool phải khai báo `_meta.ui` (parse từ tool thô).
   *   2. Negotiation: client không render được → text fallback.
   *   3. Kết quả tool phải có text fallback dùng được.
   *   4. Open policy: manifest/app phải đủ điều kiện mở.
   *   5. Tạo session bridge + policy consent cho session.
   *   6. Auto-visualiser: dữ liệu cấu trúc trong kết quả → sinh
   *      visualisation đính kèm (cả 2 mode ui/text).
   */
  openAppForClient(
    tool: unknown,
    result: unknown,
    client: V14ClientAppsCapability,
    options: OpenAppForClientV15Options = {},
  ): OpenAppForClientV15Result {
    const startedAt = this.now();
    const toolName = isRecord(tool) ? asNonEmptyString(tool['name']) : undefined;
    if (!toolName) {
      throw new McpAppHostV15Error('Tool thiếu tên — không mở được app.', 'host-v15-bad-tool');
    }
    const declaration = parseToolUiMeta(tool);
    if (!declaration) {
      throw new McpAppHostV15Error(
        `Tool "${toolName}" không khai báo _meta.ui — không có app để mở.`,
        'host-v15-tool-has-no-ui',
      );
    }
    const registration = this.registry.getToolUi(toolName);
    if (!registration) {
      throw new McpAppHostV15Error(
        `Tool "${toolName}" chưa đăng ký UI trong registry v15 — đăng ký resource + khai báo _meta.ui trước.`,
        'host-v15-tool-not-registered',
      );
    }
    const negotiation = this.registry.negotiateForTool(toolName, client);
    // Auto-visualiser chạy cho cả 2 mode (text fallback cũng có bảng).
    let visualisation: UiV15Visualisation | undefined;
    if (options.autoVisualise !== false) {
      try {
        const data = extractVisualisableData(result);
        if (data !== undefined) {
          visualisation = visualiseData(data, { title: registration.declaration.appName });
          if (visualisation.kind === 'none') visualisation = undefined;
        }
      } catch {
        visualisation = undefined;
      }
    }
    if (!negotiation.sendUi) {
      let textFallback: string | undefined;
      try {
        textFallback = this.registry.validateToolResult(toolName, result).textFallback;
      } catch {
        textFallback = this.registry.getTextFallback(toolName)?.text;
      }
      if (!textFallback) {
        throw new McpAppHostV15Error(
          `Tool "${toolName}" không có text fallback để trả cho client không render được.`,
          'host-v15-no-fallback',
        );
      }
      const fullText =
        visualisation !== undefined
          ? `${textFallback}\n\n---\n${visualisation.textFallback}`
          : textFallback;
      this.auditLog.record({
        direction: 'server',
        server: declaration.server,
        method: 'ui/open',
        tool: toolName,
        resourceUri: declaration.resourceUri,
        outcome: 'ok',
        resultSummary: 'text fallback',
        durationMs: this.now() - startedAt,
      });
      return {
        mode: 'text',
        textFallback: fullText,
        negotiation,
        ...(visualisation ? { visualisation } : {}),
      };
    }
    // Cửa UI: kết quả bắt buộc phải có text fallback dùng được.
    this.registry.validateToolResult(toolName, result);
    const policy = this.registry.checkOpenPolicy(declaration.resourceUri);
    if (!policy.allowed) {
      throw new McpAppHostV15Error(
        `Không mở được app ${declaration.resourceUri}: ${policy.reason}`,
        'host-v15-open-policy-blocked',
      );
    }
    const warnings: string[] = [];
    const manifestWarnings = this.registry.getManifestWarnings(declaration.resourceUri);
    warnings.push(...manifestWarnings);
    if (policy.reason.includes('v14 cũ')) {
      warnings.push('App v14 cũ (không có manifest v15) — nên migrate lên v15 để có sandbox/CSP rõ ràng.');
    }
    const displayMode = options.displayMode ?? declaration.displayMode ?? 'inline';
    const allowedTools = options.allowedTools ?? [toolName];
    const allowedResources = options.allowedResources ?? [declaration.resourceUri];
    // Policy consent cho session: auto-approve read-only trong list.
    this.consent.setPolicy({
      appUri: declaration.resourceUri,
      autoApproveReadOnlyTools: options.autoApproveReadOnlyTools ?? [],
      deniedTools: [],
      alwaysRequireConsentTools: [],
      allowOneShot: true,
    });
    const session = this.bridge.createSession(declaration.resourceUri, declaration.server, {
      toolName,
      allowedTools,
      allowedResources,
      allowOpenLink: options.allowOpenLink ?? false,
      allowPostMessage: options.allowPostMessage ?? false,
      expectedOrigin: options.expectedOrigin,
      displayMode,
      theme: options.theme,
      locale: options.locale,
      timezone: options.timezone,
      platform: options.platform,
    });
    const hostContext = buildHostContextV15({
      sessionId: session.sessionId,
      theme: options.theme,
      locale: options.locale,
      timezone: options.timezone,
      platform: options.platform,
      displayMode,
    });
    this.opened.set(session.sessionId, {
      appUri: declaration.resourceUri,
      toolName,
      serverName: declaration.server,
      bridgeSessionId: session.sessionId,
      displayMode,
      openedAtMs: this.now(),
      ...(options.title ? { title: options.title } : {}),
      ...(visualisation ? { visualisationKind: visualisation.kind } : {}),
    });
    this.auditLog.record({
      direction: 'server',
      server: declaration.server,
      method: 'ui/open',
      tool: toolName,
      resourceUri: declaration.resourceUri,
      sessionId: session.sessionId,
      outcome: 'ok',
      resultSummary: `ui ${displayMode}`,
      durationMs: this.now() - startedAt,
    });
    return {
      mode: 'ui',
      appUri: declaration.resourceUri,
      bridgeSessionId: session.sessionId,
      hostContext,
      negotiation,
      ...(visualisation ? { visualisation } : {}),
      warnings,
    };
  }

  /** Lấy app đang mở theo bridge session id. */
  getOpenedApp(sessionId: string): OpenedAppV15 | undefined {
    return this.opened.get(sessionId);
  }

  /** Liệt kê app đang mở (mới nhất cuối). */
  listOpenApps(): OpenedAppV15[] {
    return [...this.opened.values()].sort((a, b) => a.openedAtMs - b.openedAtMs);
  }

  /**
   * Đóng app theo bridge session id: đóng session bridge + xoá khỏi
   * danh sách mở + ghi audit. Trả false khi không có app đó.
   */
  closeAppBySession(sessionId: string): boolean {
    const opened = this.opened.get(sessionId);
    if (!opened) return false;
    this.opened.delete(sessionId);
    this.bridge.closeSession(sessionId);
    this.auditLog.record({
      direction: 'server',
      server: opened.serverName,
      method: 'ui/close',
      tool: opened.toolName,
      resourceUri: opened.appUri,
      sessionId,
      outcome: 'ok',
      durationMs: 0,
    });
    return true;
  }

  // -- bridge message --------------------------------------------------------

  /**
   * Xử lý một message postMessage từ app (renderer đưa event.data
   * vào đây). Trả JSON-RPC response hoặc null (notification).
   */
  async handleBridgeMessage(
    sessionId: string,
    data: unknown,
    origin: unknown,
  ): Promise<JsonRpcResponse | null> {
    return this.bridge.handleMessage(sessionId, data, origin);
  }

  /** Session bridge snapshot (cho panel/debug). */
  listBridgeSessions(): UiBridgeV15SessionSnapshot[] {
    return this.bridge.listSessions();
  }

  // -- tools/call + consent --------------------------------------------------

  /**
   * Bridge gọi khi app xin tools/call: phân loại action, xin
   * consent khi cần. Trả consent id khi cần user quyết (bridge giữ
   * request pending + trả lỗi consentRequired cho app); trả
   * undefined khi được chạy ngay (read-only auto-approve hoặc
   * consent đã duyệt từ trước — không có trường hợp này ở v15:
   * consent luôn đi qua requestConsent).
   */
  private requireConsentForBridgeCall(
    sessionId: string,
    request: { id?: string | number | null; params?: unknown },
  ): string | undefined {
    const session = this.bridge.getSession(sessionId);
    if (!session) return undefined;
    const params = isRecord(request.params) ? request.params : {};
    const toolName = asNonEmptyString(params['name']) ?? '';
    const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    const classification = classifyToolCallV15(toolName, args);
    // Read-only + đã duyệt auto trước đó thì không cần consent mới —
    // kiểm tra policy: auto-approve chỉ khi tool trong allowlist.
    const policy = this.consent.getPolicy(session.appUri);
    const autoOk =
      classification.kind === 'read-only' &&
      (policy?.autoApproveReadOnlyTools.includes(toolName) ?? false);
    if (autoOk) {
      // Ghi audit auto-approve qua một consent request auto.
      const auto = this.consent.requestConsent({
        sessionId,
        appUri: session.appUri,
        serverName: session.serverName,
        toolName,
        args,
      });
      // requestConsent đã auto-approve + audit; bridge chạy tool ngay.
      void auto;
      return undefined;
    }
    // Còn lại: tạo consent pending, báo cho UI hiện hộp thoại.
    const consent = this.consent.requestConsent({
      sessionId,
      appUri: session.appUri,
      serverName: session.serverName,
      toolName,
      args,
      ...(request.id !== undefined && request.id !== null ? { bridgeRequestId: request.id } : {}),
    });
    this.options.onConsentRequested?.(consent);
    this.auditLog.record({
      direction: 'server',
      server: session.serverName,
      method: 'tools/call',
      tool: toolName,
      resourceUri: session.appUri,
      sessionId,
      outcome: 'ok',
      resultSummary: `consent ${consent.id} (${consent.kind})`,
      durationMs: 0,
    });
    return consent.id;
  }

  /**
   * Thực thi tools/call sau khi đã qua consent (bridge gọi).
   * Không có handler → từ chối (không chạy tool âm thầm).
   */
  private async executeToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = this.now();
    const session = this.bridge.getSession(sessionId);
    if (!this.options.onToolsCall) {
      throw new McpAppHostV15Error(
        'Host chưa cấu hình handler tools/call — app không gọi được tool nào.',
        'host-v15-no-tools-handler',
      );
    }
    try {
      const result = await this.options.onToolsCall(sessionId, toolName, args);
      this.auditLog.record({
        direction: 'server',
        server: session?.serverName ?? 'mcp-apps-v15',
        method: 'tools/call',
        tool: toolName,
        resourceUri: session?.appUri,
        sessionId,
        args,
        outcome: 'ok',
        durationMs: this.now() - startedAt,
      });
      return result;
    } catch (err) {
      this.auditLog.record({
        direction: 'server',
        server: session?.serverName ?? 'mcp-apps-v15',
        method: 'tools/call',
        tool: toolName,
        resourceUri: session?.appUri,
        sessionId,
        args,
        outcome: 'tool-error',
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: this.now() - startedAt,
      });
      throw err;
    }
  }

  /**
   * User quyết định consent: duyệt → chạy request tools/call đang
   * pending (bridge trả response cho app) + consume one-shot;
   * từ chối → bridge trả lỗi consentDenied cho app. Trả response
   * JSON-RPC để renderer postMessage về app (null khi không có
   * pending request gắn với consent).
   */
  async decideConsent(
    consentId: string,
    decision: 'approved' | 'denied',
  ): Promise<JsonRpcResponse | null> {
    const consent = this.consent.get(consentId);
    if (!consent) {
      throw new McpAppHostV15Error(
        `Consent ${consentId} không tồn tại.`,
        'host-v15-consent-not-found',
      );
    }
    const decided = this.consent.decide(consentId, decision);
    // Không có bridge request gắn với consent → không có gì để chạy
    // lại; renderer tự post notification ui/consent-decided về app
    // bằng `bridge.notifyConsentDecided(...)` khi cần.
    if (decided.bridgeRequestId === undefined) return null;
    // Duyệt: chạy tool đang pending (với đúng args gốc), rồi
    // consume one-shot để consent không dùng lại được.
    const response = await this.bridge.resolvePendingAfterConsent(
      decided.sessionId,
      decided.bridgeRequestId,
      decision,
    );
    if (decision === 'approved') this.consent.consume(consentId);
    return response;
  }

  /** Quét consent hết hạn. Trả số đã hết hạn. */
  expireConsents(): number {
    return this.consent.expireSweep();
  }

  /** Liệt kê consent đang chờ (cho panel). */
  listPendingConsents(filter: { appUri?: string; sessionId?: string } = {}): UiV15ConsentRequest[] {
    return this.consent.listPending(filter);
  }

  // -- parse capability client (tiện cho tool/renderer) ---------------------

  /** Parse capability client từ handshake MCP thô (uỷ quyền v14). */
  parseClientCapability(handshake: unknown): V14ClientAppsCapability {
    return parseV14ClientCapability(handshake);
  }

  /** Thống kê host v15 (registry + bridge + consent + visualiser). */
  stats(): {
    registry: ReturnType<McpAppsUiRegistryV15['stats']>;
    bridgeSessions: number;
    openApps: number;
    consent: ReturnType<UiConsentManagerV15['stats']>;
    visualiser: ReturnType<AutoVisualiserV15['stats']>;
    skills: number;
    auditEntries: number;
  } {
    return {
      registry: this.registry.stats(),
      bridgeSessions: this.bridge.size,
      openApps: this.opened.size,
      consent: this.consent.stats(),
      visualiser: this.visualiser.stats(),
      skills: this.skills.size,
      auditEntries: this.auditLog.all().length,
    };
  }
}

/** Trích dữ liệu vẽ được từ kết quả tools/call (content text JSON). */
export function extractVisualisableData(result: unknown): unknown | undefined {
  if (!isRecord(result)) return undefined;
  const content = result['content'];
  if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (!isRecord(block) || block['type'] !== 'text') continue;
      const text = asNonEmptyString(block['text']);
      if (!text) continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed) || isRecord(parsed)) return parsed;
      } catch {
        // Text không phải JSON — không vẽ được, bỏ qua.
      }
    }
    return undefined;
  }
  const data = result['data'];
  if (Array.isArray(data) || isRecord(data)) return data;
  return undefined;
}

// Re-export tiện cho caller dùng host v15 qua một import.
export { parseV14ClientCapability };
export type { ToolUiRegistrationV15 };
