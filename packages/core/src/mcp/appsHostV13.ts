/**
 * MCP Apps host v13 — orchestrator (ideas only).
 *
 * Một chỗ duy nhất nối các mảnh v13 lại với nhau để mở một app từ
 * lúc tool trả kết quả cho tới lúc renderer mount iframe:
 *
 *   tool `_meta.ui` (appsUiMeta)
 *     → tìm HTML: resource khớp resourceUri trong kết quả tool,
 *       rồi registry `ui://`, rồi `parseAppResult` chung
 *     → validate + đăng ký registry `ui://`
 *     → mở trong AppManager (giới hạn 10 app)
 *     → đăng ký display mode (inline/fullscreen/pip)
 *     → tạo session dialect JSON-RPC `ui/` (+ session bridge legacy
 *       `app-*` khi app cũ yêu cầu)
 *     → trả frame config (sandbox `allow-scripts` + CSP deny + srcdoc)
 *
 * Ngoài ra host còn:
 *   - Mở app từ component kit (`openAppFromComponents`) và 4 sample
 *     app mẫu (`openSampleApp`: dashboard / form / monitor / table).
 *   - Đẩy model context xuống app (`updateModelContext` → notification
 *     `ui/model-context-updated` để renderer postMessage).
 *   - Nối app với MCP Task (`linkTask` / `pushTaskProgress`): tiến độ
 *     task chảy vào model context của app, để app monitoring hiển thị
 *     trạng thái task dài mà không cần poll.
 *
 * Host không chạm DOM / network: mọi hàm trả object để renderer (hoặc
 * tool) thực thi. `onToolsCall` / `onOpenLink` do coordinator nối vào
 * (mặc định: tools/call bị từ chối, link bị chặn — fail-closed).
 */

import { buildAppFrameConfig, parseAppResult, validateAppHtml, type AppFrameConfig, type McpAppDefinition } from './apps';
import { AppBridgeHost } from './appsBridge';
import { AppManager } from './appsManager';
import {
  renderAppComponents,
  type AppComponent,
} from './appsComponents';
import {
  AppDisplayModeManager,
  parseDisplayMode,
  type AppDisplayMode,
  type AppDisplayState,
} from './appsDisplayModes';
import {
  buildDefaultHostContext,
  UiDialectHost,
  type JsonRpcRequest,
  type UiDialectSessionSnapshot,
  type UiHostContext,
  type UiModelContext,
} from './appsUiDialect';
import { McpAppUiRegistry, type UiResourceEntry } from './appsUiRegistry';
import {
  matchDeclaredResourceInResult,
  parseToolUiMeta,
  type ToolUiDeclaration,
} from './appsUiMeta';
import type { McpToolCallResult } from './types';

export class McpAppHostV13Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppHostV13Error';
    this.code = code;
  }
}

/** App đã mở xong, sẵn sàng mount (renderer chỉ việc dùng frameConfig + sessionId). */
export interface OpenedAppV13 {
  /** Id của AppManager (ổn định trong phiên). */
  appId: string;
  /** Session id của dialect JSON-RPC `ui/`. */
  dialectSessionId: string;
  /** Session id bridge legacy `app-*` (chỉ khi dùng legacy bridge). */
  bridgeSessionId?: string;
  /** URI `ui://` của app. */
  uri: string;
  title: string;
  serverName: string;
  toolName?: string;
  displayMode: AppDisplayMode;
  displayState: AppDisplayState;
  frameConfig: AppFrameConfig;
  hostContext: UiHostContext;
}

/** Snapshot app đang mở cho UI (không kèm HTML). */
export interface OpenAppV13Snapshot {
  appId: string;
  uri: string;
  title: string;
  serverName: string;
  toolName?: string;
  origin: McpAppDefinition['origin'];
  openedAt: number;
  htmlBytes: number;
  displayMode: AppDisplayMode;
  pip?: AppDisplayState['pip'];
  pinned: boolean;
  dialectInitialized: boolean;
  modelContext: UiModelContext;
}

/** Tuỳ chọn mở app từ kết quả tool. */
export interface OpenAppFromToolOptions {
  /** Display mode muốn dùng (ưu tiên hơn `_meta.ui.displayMode`). */
  displayMode?: AppDisplayMode;
  /** Host ngoài được phép trong CSP (mặc định: không host nào). */
  allowedHosts?: string[];
  /** Dùng thêm bridge legacy `app-*` cho app cũ (mặc định false — chỉ dialect `ui/`). */
  useLegacyBridge?: boolean;
  /** Tool app được phép gọi qua dialect (mặc định: chỉ tool đã tạo ra app). */
  allowedTools?: string[];
  /** App có được mở link ngoài không (mặc định false). */
  allowOpenLink?: boolean;
  /** Tiêu đề ghi đè. */
  title?: string;
}

export interface McpAppHostV13Options {
  now?: () => number;
  registry?: McpAppUiRegistry;
  manager?: AppManager;
  bridge?: AppBridgeHost;
  dialect?: UiDialectHost;
  displayModes?: AppDisplayModeManager;
  hostContext?: UiHostContext;
  /** Handler thực thi tools/call cho app. */
  onToolsCall?: (sessionId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Handler quyết định mở link ngoài. */
  onOpenLink?: (sessionId: string, url: string) => boolean | Promise<boolean>;
  /** App gửi message về host. */
  onMessage?: (sessionId: string, message: string, level: 'info' | 'warn' | 'error') => void;
  /** App cập nhật model context. */
  onModelContext?: (sessionId: string, context: UiModelContext) => void;
  /** Display mode của app đổi (do app xin hoặc host đổi). */
  onDisplayModeChange?: (appId: string, mode: AppDisplayMode) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Các sample app có sẵn (dùng component kit, không cần server). */
export const MCP_APP_V13_SAMPLE_KINDS = ['dashboard', 'form', 'monitor', 'table'] as const;
export type McpAppV13SampleKind = (typeof MCP_APP_V13_SAMPLE_KINDS)[number];

/** Component của từng sample app. */
export function buildSampleAppComponents(kind: McpAppV13SampleKind): AppComponent[] {
  switch (kind) {
    case 'dashboard':
      return [
        {
          type: 'grid',
          columns: 3,
          children: [
            { type: 'metric', label: 'Task đang chạy', value: 3, trend: 'up', delta: '+1 so với hôm qua' },
            { type: 'metric', label: 'App đang mở', value: 2, trend: 'flat', delta: 'không đổi' },
            { type: 'metric', label: 'Tool đã gọi', value: 128, unit: 'lần', trend: 'up', delta: '+12%' },
          ],
        },
        {
          type: 'chart-placeholder',
          title: 'Tool gọi theo giờ',
          kind: 'bar',
          labels: ['08h', '10h', '12h', '14h', '16h', '18h'],
          values: [12, 24, 18, 32, 27, 15],
          unit: 'lần',
        },
        {
          type: 'list',
          title: 'Hoạt động gần đây',
          items: [
            { title: 'Mở dashboard mẫu', description: 'App mẫu của host v13', badge: 'mới' },
            { title: 'Task backup hoàn thành', description: 'Chạy nền 4 phút 12 giây' },
            { title: 'Đồng bộ Composio', description: '3 kết nối đang hoạt động' },
          ],
        },
      ];
    case 'form':
      return [
        {
          type: 'form',
          title: 'Gửi phản hồi về open-bot',
          description: 'Form mẫu: submit gọi tool qua dialect ui/ (tools/call), không gửi đi đâu khác.',
          tool: 'mcp_apps_ui_sample',
          fields: [
            { name: 'name', label: 'Tên của bạn', type: 'text', required: true, placeholder: 'vd Huy' },
            { name: 'rating', label: 'Chấm điểm', type: 'select', options: ['5 — Rất tốt', '4 — Tốt', '3 — Bình thường', '2 — Kém', '1 — Rất kém'], defaultValue: '5 — Rất tốt' },
            { name: 'notes', label: 'Ghi chú', type: 'textarea', placeholder: 'Bạn muốn open-bot làm tốt hơn ở đâu?' },
            { name: 'notify', label: 'Nhận thông báo khi có bản mới', type: 'checkbox', defaultValue: true },
          ],
          submitLabel: 'Gửi phản hồi',
        },
        {
          type: 'card',
          title: 'Form này làm được gì?',
          description: 'Mỗi lần submit, shim ui/ gửi tools/call về host; host trả kết quả và form hiện ngay bên dưới. Không có mạng ngoài, không lưu trữ.',
        },
      ];
    case 'monitor':
      return [
        { type: 'metric', label: 'Tiến độ task dài', value: 42, unit: '%', trend: 'up', delta: 'đang chạy' },
        {
          type: 'chart-placeholder',
          title: 'Tiến độ theo phút',
          kind: 'line',
          labels: ['-5p', '-4p', '-3p', '-2p', '-1p', 'nay'],
          values: [8, 15, 22, 29, 36, 42],
          unit: '%',
        },
        {
          type: 'list',
          title: 'Sự kiện',
          items: [
            { title: 'Task bắt đầu', description: '5 phút trước', badge: 'task' },
            { title: 'Checkpoint 25%', description: 'Đã lưu trạng thái' },
            { title: 'Checkpoint 40%', description: 'Đã lưu trạng thái' },
          ],
        },
      ];
    case 'table':
      return [
        {
          type: 'table',
          title: 'Các MCP server đã kết nối',
          caption: 'Bảng mẫu — dữ liệu tĩnh của sample app',
          columns: ['Server', 'Tool', 'App', 'Trạng thái'],
          rows: [
            ['filesystem', 'read-file', 'ui://filesystem/viewer', 'đang chạy'],
            ['github', 'list-issues', 'ui://github/issues', 'đang chạy'],
            ['local-tools', 'run-shell', 'ui://local-tools/console', 'tạm dừng'],
          ],
        },
        {
          type: 'card',
          title: 'Muốn xem app thật?',
          description: 'Khi MCP server trả resource text/html;profile=mcp-app, host mở app thật thay cho bảng mẫu này.',
          actions: [{ label: 'Mở dashboard mẫu', tool: 'mcp_apps_ui_sample', arguments: { kind: 'dashboard' } }],
        },
      ];
  }
}

/** Tiêu đề + display mode mặc định của từng sample app. */
export function sampleAppMeta(kind: McpAppV13SampleKind): { title: string; displayMode: AppDisplayMode; uri: string } {
  switch (kind) {
    case 'dashboard':
      return { title: 'Dashboard mẫu — MCP Apps v13', displayMode: 'inline', uri: 'ui://local/sample-dashboard' };
    case 'form':
      return { title: 'Form mẫu — MCP Apps v13', displayMode: 'inline', uri: 'ui://local/sample-form' };
    case 'monitor':
      return { title: 'Monitor mẫu — MCP Apps v13', displayMode: 'pip', uri: 'ui://local/sample-monitor' };
    case 'table':
      return { title: 'Bảng mẫu — MCP Apps v13', displayMode: 'inline', uri: 'ui://local/sample-table' };
  }
}

/**
 * Host v13 — nối registry + dialect + display modes + AppManager +
 * bridge legacy + Tasks. Một instance cho toàn bộ desktop.
 */
export class McpAppHostV13 {
  readonly registry: McpAppUiRegistry;
  readonly manager: AppManager;
  readonly bridge: AppBridgeHost;
  readonly dialect: UiDialectHost;
  readonly displayModes: AppDisplayModeManager;
  private readonly now: () => number;
  private readonly hostContext: UiHostContext;
  private readonly onDisplayModeChange?: McpAppHostV13Options['onDisplayModeChange'];
  /** appId -> taskId đang gắn (để đẩy tiến độ task vào app). */
  private readonly appTasks = new Map<string, string>();

  constructor(options: McpAppHostV13Options = {}) {
    this.now = options.now ?? Date.now;
    this.registry = options.registry ?? new McpAppUiRegistry({ now: this.now });
    this.manager = options.manager ?? new AppManager();
    this.bridge = options.bridge ?? new AppBridgeHost({ now: this.now });
    this.displayModes = options.displayModes ?? new AppDisplayModeManager({ now: this.now });
    this.hostContext = options.hostContext ?? buildDefaultHostContext();
    this.onDisplayModeChange = options.onDisplayModeChange;
    const onDisplayModeChange = options.onDisplayModeChange;
    this.dialect =
      options.dialect ??
      new UiDialectHost({
        now: this.now,
        onToolsCall: options.onToolsCall,
        onOpenLink: options.onOpenLink,
        onMessage: options.onMessage,
        onModelContext: options.onModelContext,
        onDisplayModeChange: (sessionId, mode) => {
          const appId = this.findAppIdByDialectSession(sessionId);
          if (appId) {
            this.displayModes.setMode(appId, mode);
            onDisplayModeChange?.(appId, mode);
          }
        },
      });
  }

  /** Host context hiện tại (bản sao). */
  getHostContext(): UiHostContext {
    return { ...this.hostContext, container: { ...this.hostContext.container } };
  }

  /** Cập nhật host context (vd theme/locale đổi) — áp cho session mới + session đang mở. */
  updateHostContext(patch: Partial<UiHostContext>): void {
    Object.assign(this.hostContext, patch);
    if (patch.container) this.hostContext.container = { ...patch.container };
    for (const session of this.dialect.listSessions()) {
      this.dialect.updateHostContext(session.sessionId, patch);
    }
  }

  /**
   * Mở app từ kết quả `tools/call` của một tool. Tìm HTML theo thứ tự:
   * 1) resource khớp `_meta.ui.resourceUri` trong kết quả,
   * 2) registry `ui://` (đã đăng ký từ `resources/read` trước đó),
   * 3) `parseAppResult` chung (3 wire shape của v0.98).
   * Ném `McpAppHostV13Error` khi không tìm thấy app hoặc app bị chặn.
   */
  openAppFromTool(
    tool: unknown,
    result: unknown,
    options: OpenAppFromToolOptions = {},
  ): OpenedAppV13 {
    const toolName = isRecord(tool) ? asNonEmptyString(tool['name']) : undefined;
    const declaration = parseToolUiMeta(tool);
    const serverName =
      declaration?.server ??
      (isRecord(tool) ? asNonEmptyString(tool['serverName']) : undefined) ??
      'unknown-server';
    let html: string | undefined;
    let sourceUri: string | undefined;
    let title = options.title ?? declaration?.title;
    let foundInResult = false;

    // 1) Resource khớp khai báo trong kết quả tool.
    if (declaration && isRecord(result) && Array.isArray(result['content'])) {
      const match = matchDeclaredResourceInResult(declaration, result);
      if (match.found) {
        foundInResult = true;
        sourceUri = match.uri;
        for (const block of result['content'] as unknown[]) {
          if (!isRecord(block)) continue;
          const resource = isRecord(block['resource']) ? block['resource'] : undefined;
          const uri = asNonEmptyString(block['uri']) ?? asNonEmptyString(resource?.['uri']);
          if (uri !== declaration.resourceUri) continue;
          const text = asNonEmptyString(block['text']) ?? asNonEmptyString(resource?.['text']);
          if (text) html = text;
          const blockTitle = asNonEmptyString(block['title']) ?? asNonEmptyString(resource?.['title']);
          if (blockTitle && !title) title = blockTitle;
          break;
        }
      }
    }

    // 2) Registry ui://.
    if (html === undefined && declaration) {
      const entry = this.registry.resolve(declaration.resourceUri);
      if (entry) {
        html = entry.html;
        sourceUri = entry.uri;
        if (!title) title = entry.title;
      }
    }

    // 3) parseAppResult chung (không cần khai báo _meta.ui).
    if (html === undefined) {
      const parsed = parseAppResult(
        result as Pick<McpToolCallResult, 'content' | 'structuredContent'>,
        { serverName, ...(toolName ? { toolName } : {}) },
        { allowedHosts: options.allowedHosts ?? [] },
      );
      if (parsed.blocked) {
        throw new McpAppHostV13Error(`App bị chặn: ${parsed.blocked}`, 'host-app-blocked');
      }
      if (parsed.app) {
        html = parsed.app.html;
        sourceUri = parsed.app.sourceUri;
        if (!title) title = parsed.app.title;
      }
    }

    if (html === undefined) {
      throw new McpAppHostV13Error(
        declaration
          ? `Tool khai báo app ${declaration.resourceUri} nhưng kết quả không chứa resource đó (và registry cũng không có).`
          : 'Kết quả tool không chứa MCP App nào.',
        'host-app-not-found',
      );
    }
    void foundInResult;

    const validation = validateAppHtml(html, { allowedHosts: options.allowedHosts ?? [] });
    if (!validation.valid) {
      const first = validation.findings.find((f) => f.severity === 'blocking');
      throw new McpAppHostV13Error(
        `App bị chặn: ${first?.message ?? 'validation failed.'}`,
        first?.code ?? 'host-app-invalid',
      );
    }

    const uri = sourceUri ?? declaration?.resourceUri ?? `ui://${serverName}/app`;
    const displayMode = options.displayMode ?? declaration?.displayMode ?? 'inline';
    const finalTitle = (title ?? uri).slice(0, 120);

    // Đăng ký registry (ghi đè entry cũ cùng URI — server cập nhật app).
    let registryEntry: UiResourceEntry | undefined;
    try {
      registryEntry = this.registry.register({
        uri,
        serverName,
        ...(toolName ? { toolName } : {}),
        title: finalTitle,
        html,
        mimeType: 'text/html;profile=mcp-app',
        displayMode,
      });
    } catch {
      // Registry đầy / lỗi đăng ký không chặn việc mở app — app vẫn mở từ HTML đã validate.
      registryEntry = undefined;
    }
    void registryEntry;

    const app = this.manager.open({
      serverName,
      ...(toolName ? { toolName } : {}),
      title: finalTitle,
      html,
      ...(uri ? { sourceUri: uri } : {}),
      origin: 'tool-result',
    });
    return this.finishOpen(app, {
      uri,
      displayMode,
      allowedHosts: options.allowedHosts ?? [],
      useLegacyBridge: options.useLegacyBridge ?? false,
      allowedTools: options.allowedTools ?? (toolName ? [toolName] : []),
      allowOpenLink: options.allowOpenLink ?? false,
    });
  }

  /**
   * Mở app đã đăng ký trong registry `ui://` theo URI. Ném
   * `McpAppHostV13Error` khi URI chưa đăng ký hoặc đã hết hạn.
   */
  openAppFromRegistry(
    uri: string,
    options: {
      displayMode?: AppDisplayMode;
      allowedHosts?: string[];
      useLegacyBridge?: boolean;
      allowedTools?: string[];
      allowOpenLink?: boolean;
      title?: string;
    } = {},
  ): OpenedAppV13 {
    const entry = this.registry.resolve(uri);
    if (!entry) {
      throw new McpAppHostV13Error(
        `Không có app nào đăng ký cho "${uri}" (chưa đăng ký hoặc đã hết hạn).`,
        'host-app-not-registered',
      );
    }
    const title = (options.title ?? entry.title).slice(0, 120);
    const app = this.manager.open({
      serverName: entry.serverName,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      title,
      html: entry.html,
      sourceUri: entry.uri,
      origin: 'tool-result',
    });
    return this.finishOpen(app, {
      uri: entry.uri,
      displayMode: options.displayMode ?? entry.displayMode ?? 'inline',
      allowedHosts: options.allowedHosts ?? [],
      useLegacyBridge: options.useLegacyBridge ?? false,
      allowedTools: options.allowedTools ?? (entry.toolName ? [entry.toolName] : []),
      allowOpenLink: options.allowOpenLink ?? false,
    });
  }

  /**
   * Mở app từ danh sách component khai báo (không cần server): render
   * thành HTML bằng component kit rồi mở như app thường (server `local`).
   */
  openAppFromComponents(
    components: readonly AppComponent[],
    options: {
      title?: string;
      uri?: string;
      displayMode?: AppDisplayMode;
      allowedTools?: string[];
      allowOpenLink?: boolean;
      theme?: 'light' | 'dark';
    } = {},
  ): OpenedAppV13 {
    const html = renderAppComponents(components, {
      title: options.title ?? 'MCP App',
      theme: options.theme,
    });
    const uri = options.uri ?? `ui://local/components-${this.now()}`;
    const title = (options.title ?? 'MCP App').slice(0, 120);
    try {
      this.registry.register({
        uri,
        serverName: 'local',
        title,
        html,
        mimeType: 'text/html;profile=mcp-app',
        displayMode: options.displayMode ?? 'inline',
      });
    } catch {
      // Registry lỗi không chặn mở app từ component.
    }
    const app = this.manager.open({
      serverName: 'local',
      title,
      html,
      sourceUri: uri,
      origin: 'manual',
    });
    return this.finishOpen(app, {
      uri,
      displayMode: options.displayMode ?? 'inline',
      allowedHosts: [],
      useLegacyBridge: false,
      allowedTools: options.allowedTools ?? [],
      allowOpenLink: options.allowOpenLink ?? false,
    });
  }

  /** Mở một trong 4 sample app (dashboard / form / monitor / table). */
  openSampleApp(
    kind: McpAppV13SampleKind,
    options: { allowedTools?: string[] } = {},
  ): OpenedAppV13 {
    if (!(MCP_APP_V13_SAMPLE_KINDS as readonly string[]).includes(kind)) {
      throw new McpAppHostV13Error(
        `Sample kind phải là một trong: ${MCP_APP_V13_SAMPLE_KINDS.join(', ')}.`,
        'host-bad-sample-kind',
      );
    }
    const meta = sampleAppMeta(kind);
    return this.openAppFromComponents(buildSampleAppComponents(kind), {
      title: meta.title,
      uri: meta.uri,
      displayMode: meta.displayMode,
      allowedTools: options.allowedTools ?? (kind === 'form' ? ['mcp_apps_ui_sample'] : []),
    });
  }

  /** Đổi display mode của app đang mở (đồng bộ cả dialect + manager). */
  setDisplayMode(appId: string, mode: AppDisplayMode): AppDisplayState {
    parseDisplayMode(mode);
    const state = this.displayModes.setMode(appId, mode);
    const dialectSessionId = this.dialectSessionByApp.get(appId);
    if (dialectSessionId) {
      this.dialect.updateHostContext(dialectSessionId, { displayMode: mode });
    }
    this.onDisplayModeChange?.(appId, mode);
    return state;
  }

  /** Thoát fullscreen/pip về mode trước đó. */
  exitOverlay(appId: string): AppDisplayState {
    const state = this.displayModes.exitOverlay(appId);
    this.onDisplayModeChange?.(appId, state.mode);
    return state;
  }

  /** Đẩy model context mới xuống app — trả notification để renderer postMessage. */
  updateModelContext(appId: string, context: UiModelContext): JsonRpcRequest | null {
    const dialectSessionId = this.dialectSessionByApp.get(appId);
    if (!dialectSessionId) return null;
    return this.dialect.buildModelContextNotification(dialectSessionId, context);
  }

  /** Gắn một MCP Task vào app (để đẩy tiến độ task vào model context). */
  linkTask(appId: string, taskId: string): void {
    if (!this.manager.get(appId)) {
      throw new McpAppHostV13Error(`Không có app "${appId}" đang mở.`, 'host-unknown-app');
    }
    this.appTasks.set(appId, taskId);
  }

  /** Task gắn với app (nếu có). */
  linkedTask(appId: string): string | undefined {
    return this.appTasks.get(appId);
  }

  /**
   * Đẩy tiến độ task vào app: cập nhật model context
   * (`taskStatus`/`progress`) và trả notification cho renderer.
   * App pip/monitor dùng cái này để hiện tiến độ task dài.
   */
  pushTaskProgress(
    appId: string,
    progress: { status: string; progress?: number; message?: string },
  ): JsonRpcRequest | null {
    const taskId = this.appTasks.get(appId);
    const context: UiModelContext = {
      taskStatus: progress.status,
      ...(progress.progress !== undefined ? { progress: progress.progress } : {}),
      ...(progress.message !== undefined ? { taskMessage: progress.message } : {}),
      ...(taskId ? { taskId } : {}),
    };
    return this.updateModelContext(appId, context);
  }

  /** Đóng app: gỡ khỏi manager + display + dialect + bridge + task link. */
  closeApp(appId: string): boolean {
    const app = this.manager.get(appId);
    if (!app) return false;
    const dialectSessionId = this.dialectSessionByApp.get(appId);
    if (dialectSessionId) this.dialect.closeSession(dialectSessionId);
    const bridgeSessionId = this.bridgeSessionByApp.get(appId);
    if (bridgeSessionId) this.bridge.closeSession(bridgeSessionId);
    this.bridgeSessionByApp.delete(appId);
    this.dialectSessionByApp.delete(appId);
    this.displayModes.unregister(appId);
    this.appTasks.delete(appId);
    return this.manager.close(appId);
  }

  /** Lấy app đầy đủ (kèm HTML) để render. */
  getApp(appId: string): McpAppDefinition | undefined {
    return this.manager.get(appId);
  }

  /** Snapshot các app đang mở cho UI (không kèm HTML). */
  listApps(): OpenAppV13Snapshot[] {
    return this.manager.list().map((snap) => {
      const display = this.displayModes.get(snap.id);
      const dialectSessionId = this.dialectSessionByApp.get(snap.id);
      const dialect = dialectSessionId ? this.dialect.getSession(dialectSessionId) : undefined;
      return {
        appId: snap.id,
        uri: snap.sourceUri ?? `ui://${snap.serverName}/app`,
        title: snap.title,
        serverName: snap.serverName,
        ...(snap.toolName ? { toolName: snap.toolName } : {}),
        origin: snap.origin,
        openedAt: snap.openedAt,
        htmlBytes: snap.htmlBytes,
        displayMode: display?.mode ?? 'inline',
        ...(display?.mode === 'pip' ? { pip: { ...display.pip } } : {}),
        pinned: display?.pinned ?? false,
        dialectInitialized: dialect?.initialized ?? false,
        modelContext: dialect?.modelContext ?? {},
      };
    });
  }

  /** Thống kê host v13. */
  stats(): {
    appsOpen: number;
    registryEntries: number;
    dialectSessions: number;
    bridgeSessions: number;
    fullscreenAppId?: string;
    pipAppIds: string[];
  } {
    return {
      appsOpen: this.manager.size,
      registryEntries: this.registry.size,
      dialectSessions: this.dialect.size,
      bridgeSessions: this.bridge.size,
      ...(this.displayModes.fullscreenAppId()
        ? { fullscreenAppId: this.displayModes.fullscreenAppId() }
        : {}),
      pipAppIds: this.displayModes.pipAppIds(),
    };
  }

  // -- nội bộ ---------------------------------------------------------------

  /** appId -> dialect sessionId. */
  private readonly dialectSessionByApp = new Map<string, string>();
  /** appId -> bridge sessionId (legacy). */
  private readonly bridgeSessionByApp = new Map<string, string>();

  private findAppIdByDialectSession(sessionId: string): string | undefined {
    for (const [appId, sid] of this.dialectSessionByApp) {
      if (sid === sessionId) return appId;
    }
    return undefined;
  }

  private finishOpen(
    app: McpAppDefinition,
    opts: {
      uri: string;
      displayMode: AppDisplayMode;
      allowedHosts: string[];
      useLegacyBridge: boolean;
      allowedTools: string[];
      allowOpenLink: boolean;
    },
  ): OpenedAppV13 {
    const displayState = this.displayModes.register(app.id, { mode: opts.displayMode });
    const hostContext: UiHostContext = {
      ...this.getHostContext(),
      displayMode: opts.displayMode,
    };
    const dialectSessionId = this.dialect.createSession({
      appUri: opts.uri,
      hostContext,
      allowedTools: opts.allowedTools,
      allowOpenLink: opts.allowOpenLink,
    });
    this.dialectSessionByApp.set(app.id, dialectSessionId);
    let bridgeSessionId: string | undefined;
    if (opts.useLegacyBridge) {
      const session = this.bridge.registerSession({
        uri: opts.uri,
        toolName: app.toolName,
        serverName: app.serverName,
        allowedTools: opts.allowedTools,
      });
      bridgeSessionId = session.sessionId;
      this.bridgeSessionByApp.set(app.id, session.sessionId);
    }
    const frameConfig = buildAppFrameConfig(
      { title: app.title, html: app.html },
      { allowedHosts: opts.allowedHosts },
    );
    return {
      appId: app.id,
      dialectSessionId,
      ...(bridgeSessionId ? { bridgeSessionId } : {}),
      uri: opts.uri,
      title: app.title,
      serverName: app.serverName,
      ...(app.toolName ? { toolName: app.toolName } : {}),
      displayMode: opts.displayMode,
      displayState,
      frameConfig,
      hostContext,
    };
  }
}
