/**
 * MCP Apps + Tasks — tool definitions cho agent (v1.09, Team T3).
 *
 * Đăng ký các tool `mcp_apps_*` / `mcp_tasks_*` để agent (và user
 * qua chat) điều khiển Apps + Tasks mà không cần chạm code:
 *
 *   Apps:
 *   - `mcp_apps_validate` — validate HTML của app trước khi render
 *     (trả findings + errors, không render app lỗi).
 *   - `mcp_apps_open` — mở app (validate + đăng ký bridge session,
 *     trả frame config cho renderer: sandbox + CSP + sessionId).
 *   - `mcp_apps_list` — liệt kê app đang mở (snapshot, không lộ nonce).
 *   - `mcp_apps_close` — đóng app theo sessionId.
 *   Tasks:
 *   - `mcp_tasks_negotiate` — đàm phán capability Apps/Tasks của
 *     một server từ `initialize` result của nó.
 *   - `mcp_tasks_create` — chạy một method dưới dạng task dài
 *     (retry + timeout + progress qua runner).
 *   - `mcp_tasks_cancel` — huỷ task đang chạy.
 *   - `mcp_tasks_resume` — resume các task đã lưu sau khi app
 *     restart (re-attach bằng taskId).
 *
 * `McpAppsTasksToolHost` giữ các dependency (AppManager,
 * AppBridgeHost, McpTaskRunner, CapabilityNegotiator, transport
 * theo server) — coordinator nối host thật vào; tool chạy hoàn
 * toàn local, không gọi mạng ngoài, không cần key.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import type { ToolDefinition } from '../types';
import { buildAppFrameConfig, validateAppHtml } from './apps';
import { AppManager } from './appsManager';
import { AppBridgeHost } from './appsBridge';
import { CapabilityNegotiator, negotiateServerCapabilities } from './capabilityNegotiation';
import { McpTaskRunner, type ResumableTaskDescriptor } from './tasksRunner';
import type { McpTaskSpecVersion, McpTaskTransport } from './tasks';

export const MCP_APPS_TASKS_TOOL_NAMES = [
  'mcp_apps_validate',
  'mcp_apps_open',
  'mcp_apps_list',
  'mcp_apps_close',
  'mcp_tasks_negotiate',
  'mcp_tasks_create',
  'mcp_tasks_cancel',
  'mcp_tasks_resume',
] as const;
export type McpAppsTasksToolName = (typeof MCP_APPS_TASKS_TOOL_NAMES)[number];

function jsonSchemaProps(props: Record<string, Record<string, unknown>>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/** Toàn bộ ToolDefinition của nhóm mcp_apps_* / mcp_tasks_*. */
export const MCP_APPS_TASKS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'mcp_apps_validate',
    description:
      'Validate HTML của một MCP App trước khi render: kiểm tra kích thước, tag/script cấm, link ngoài, storage, parent access. Trả findings (blocking/warning) và errors. Chỉ render app khi valid=true.',
    parameters: jsonSchemaProps(
      {
        html: { type: 'string', description: 'HTML của app cần validate.' },
        allowedHosts: { type: 'array', items: { type: 'string' }, description: 'Host ngoài được phép (mặc định: không host nào).' },
      },
      ['html'],
    ),
  },
  {
    name: 'mcp_apps_open',
    description:
      'Mở một MCP App: validate HTML, đăng ký bridge session, trả frame config (sandbox + CSP + sessionId) cho renderer hiển thị trong sandboxed iframe. App chỉ giao tiếp qua postMessage bridge.',
    parameters: jsonSchemaProps(
      {
        html: { type: 'string', description: 'HTML của app.' },
        title: { type: 'string', description: 'Tiêu đề hiển thị.' },
        uri: { type: 'string', description: 'URI của app (vd ui://server/app).' },
        toolName: { type: 'string', description: 'Tên tool đã tạo ra app.' },
        serverName: { type: 'string', description: 'Tên MCP server sở hữu app.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool mà app được phép gọi qua bridge.' },
      },
      ['html'],
    ),
  },
  {
    name: 'mcp_apps_list',
    description: 'Liệt kê các MCP App đang mở (sessionId, title, URI, trạng thái ready, số message). Không lộ nonce của session.',
    parameters: jsonSchemaProps({}),
  },
  {
    name: 'mcp_apps_close',
    description: 'Đóng một MCP App đang mở theo sessionId.',
    parameters: jsonSchemaProps(
      { sessionId: { type: 'string', description: 'SessionId của app (xem mcp_apps_list).' } },
      ['sessionId'],
    ),
  },
  {
    name: 'mcp_tasks_negotiate',
    description:
      'Đàm phán capability MCP Apps/Tasks của một server từ initialize result của nó. Trả mức hỗ trợ (full/partial/none) từng extension, spec version tasks, và ghi chú fallback cho UI.',
    parameters: jsonSchemaProps(
      {
        serverName: { type: 'string', description: 'Tên MCP server.' },
        protocolVersion: { type: 'string', description: 'Protocol version đã thương lượng (vd 2026-07-28).' },
        capabilities: { type: 'object', description: 'Object capabilities từ initialize result của server.' },
      },
      ['serverName'],
    ),
  },
  {
    name: 'mcp_tasks_create',
    description:
      'Chạy một MCP method dưới dạng task dài chạy nền (retry với backoff, timeout tổng, progress 0-100%). Trả outcome khi task tới trạng thái cuối. Server không hỗ trợ Tasks thì nên chạy tool thường thay vì dùng tool này.',
    parameters: jsonSchemaProps(
      {
        serverName: { type: 'string', description: 'Tên MCP server sẽ chạy task.' },
        method: { type: 'string', description: 'Method MCP (thường là tools/call).' },
        params: { type: 'object', description: 'Params JSON-RPC của method.' },
        specVersion: { type: 'string', enum: ['2025-11-25', '2026-07-28'], description: 'Spec version tasks (mặc định 2026-07-28).' },
        timeoutMs: { type: 'number', description: 'Timeout tổng (ms, 0 = không giới hạn).' },
        maxAttempts: { type: 'number', description: 'Số lần retry tối đa sau lần đầu (mặc định 3).' },
      },
      ['serverName', 'method'],
    ),
  },
  {
    name: 'mcp_tasks_cancel',
    description: 'Huỷ một MCP task đang chạy (hoặc đang xếp hàng) theo taskId.',
    parameters: jsonSchemaProps(
      { taskId: { type: 'string', description: 'TaskId cần huỷ.' } },
      ['taskId'],
    ),
  },
  {
    name: 'mcp_tasks_resume',
    description:
      'Resume các MCP task đã lưu sau khi app restart: re-attach bằng taskId và poll tiếp tới trạng thái cuối. Task nào server đã quên được báo orphaned thay vì chạy lại từ đầu.',
    parameters: jsonSchemaProps(
      {
        serverName: { type: 'string', description: 'Tên MCP server sở hữu các task.' },
        tasks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Danh sách task đã lưu: [{ taskId, method, label, specVersion?, pollIntervalMs? }].',
        },
      },
      ['serverName', 'tasks'],
    ),
  },
];

/** Kết quả chạy một tool (JSON-safe, trả về cho agent). */
export interface McpAppsTasksToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Dependency cho McpAppsTasksToolHost. */
export interface McpAppsTasksToolHostOptions {
  appManager?: AppManager;
  bridge?: AppBridgeHost;
  runner?: McpTaskRunner;
  negotiator?: CapabilityNegotiator;
  /** Transport theo serverName (để chạy task). */
  transports?: Map<string, McpTaskTransport> | Record<string, McpTaskTransport>;
  /** Đăng ký transport cho một server. */
  registerTransport?: (serverName: string, transport: McpTaskTransport) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Host thực thi các tool mcp_apps_* / mcp_tasks_*. */
export class McpAppsTasksToolHost {
  private readonly appManager: AppManager;
  private readonly bridge: AppBridgeHost;
  private readonly runner: McpTaskRunner;
  private readonly negotiator: CapabilityNegotiator;
  private readonly transports = new Map<string, McpTaskTransport>();

  constructor(options: McpAppsTasksToolHostOptions = {}) {
    this.appManager = options.appManager ?? new AppManager();
    this.bridge = options.bridge ?? new AppBridgeHost();
    this.runner = options.runner ?? new McpTaskRunner();
    this.negotiator = options.negotiator ?? new CapabilityNegotiator();
    if (options.transports) {
      const entries =
        options.transports instanceof Map
          ? [...options.transports.entries()]
          : Object.entries(options.transports);
      for (const [name, transport] of entries) this.transports.set(name, transport);
    }
  }

  get manager(): AppManager {
    return this.appManager;
  }

  get bridgeHost(): AppBridgeHost {
    return this.bridge;
  }

  get taskRunner(): McpTaskRunner {
    return this.runner;
  }

  get capabilityNegotiator(): CapabilityNegotiator {
    return this.negotiator;
  }

  registerTransport(serverName: string, transport: McpTaskTransport): void {
    this.transports.set(serverName, transport);
  }

  private transportFor(serverName: string): McpTaskTransport | undefined {
    return this.transports.get(serverName);
  }

  /** Chạy một tool theo tên + args (đã parse). Tool lạ -> lỗi rõ ràng. */
  async runTool(name: string, args: Record<string, unknown>): Promise<McpAppsTasksToolResult> {
    try {
      switch (name) {
        case 'mcp_apps_validate':
          return this.validateApp(args);
        case 'mcp_apps_open':
          return this.openApp(args);
        case 'mcp_apps_list':
          return this.listApps();
        case 'mcp_apps_close':
          return this.closeApp(args);
        case 'mcp_tasks_negotiate':
          return this.negotiate(args);
        case 'mcp_tasks_create':
          return await this.createTask(args);
        case 'mcp_tasks_cancel':
          return this.cancelTask(args);
        case 'mcp_tasks_resume':
          return await this.resumeTasks(args);
        default:
          return { ok: false, error: `Tool không tồn tại trong nhóm mcp_apps_*/mcp_tasks_*: "${name}".` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private validateApp(args: Record<string, unknown>): McpAppsTasksToolResult {
    const html = asNonEmptyString(args['html']);
    if (!html) return { ok: false, error: 'mcp_apps_validate cần "html" (string không rỗng).' };
    const allowedHosts = Array.isArray(args['allowedHosts'])
      ? (args['allowedHosts'] as unknown[]).filter((h): h is string => typeof h === 'string')
      : undefined;
    const result = validateAppHtml(html, allowedHosts ? { allowedHosts } : undefined);
    return {
      ok: result.valid,
      data: {
        valid: result.valid,
        errors: result.errors,
        findings: result.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
      },
      ...(result.valid ? {} : { error: result.errors.join('; ') }),
    };
  }

  private openApp(args: Record<string, unknown>): McpAppsTasksToolResult {
    const html = asNonEmptyString(args['html']);
    if (!html) return { ok: false, error: 'mcp_apps_open cần "html" (string không rỗng).' };
    const validation = validateAppHtml(html);
    if (!validation.valid) {
      return { ok: false, error: `App không hợp lệ: ${validation.errors.join('; ')}` };
    }
    const title = asNonEmptyString(args['title']) ?? 'MCP App';
    const uri = asNonEmptyString(args['uri']) ?? `ui://app/${Date.now()}`;
    const toolName = asNonEmptyString(args['toolName']) ?? 'unknown';
    const serverName = asNonEmptyString(args['serverName']) ?? 'unknown';
    const allowedTools = Array.isArray(args['allowedTools'])
      ? (args['allowedTools'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const frame = buildAppFrameConfig({ title, html });
    const session = this.bridge.registerSession({ uri, toolName, serverName, allowedTools });
    const opened = this.appManager.open({
      serverName,
      toolName,
      title,
      html,
      sourceUri: uri,
      origin: 'tool-result',
    });
    return {
      ok: true,
      data: {
        appId: opened.id,
        sessionId: session.sessionId,
        title,
        uri,
        sandbox: frame.sandbox,
        csp: frame.csp,
        warnings: validation.findings.filter((f) => f.severity === 'warning').map((f) => f.code),
      },
    };
  }

  private listApps(): McpAppsTasksToolResult {
    const sessions = this.bridge.listSessions().map((s) => ({
      sessionId: s.sessionId,
      uri: s.uri,
      toolName: s.toolName,
      serverName: s.serverName,
      ready: s.ready,
      messagesIn: s.messagesIn,
      messagesOut: s.messagesOut,
      dropped: s.dropped,
    }));
    return { ok: true, data: { apps: sessions, count: sessions.length, openInManager: this.appManager.list().length } };
  }

  private closeApp(args: Record<string, unknown>): McpAppsTasksToolResult {
    const sessionId = asNonEmptyString(args['sessionId']);
    if (!sessionId) return { ok: false, error: 'mcp_apps_close cần "sessionId".' };
    const closedBridge = this.bridge.closeSession(sessionId);
    // AppManager dùng id riêng (không phải sessionId) — đóng theo uri
    // nếu tìm được app khớp session đang mở.
    const sessionApps = this.appManager.list();
    void sessionApps;
    return { ok: closedBridge, ...(closedBridge ? { data: { sessionId, closed: true } } : { error: `Không có app nào với sessionId "${sessionId}".` }) };
  }

  private negotiate(args: Record<string, unknown>): McpAppsTasksToolResult {
    const serverName = asNonEmptyString(args['serverName']);
    if (!serverName) return { ok: false, error: 'mcp_tasks_negotiate cần "serverName".' };
    const capabilities = isRecord(args['capabilities']) ? args['capabilities'] : {};
    const protocolVersion = asNonEmptyString(args['protocolVersion']);
    const record = negotiateServerCapabilities(serverName, { protocolVersion, capabilities });
    this.negotiator.negotiate(serverName, { protocolVersion, capabilities });
    return {
      ok: true,
      data: {
        serverName,
        protocolVersion: record.protocolVersion,
        appsLevel: record.apps.level,
        tasksLevel: record.tasks.level,
        tasksSpecVersion: record.tasks.specVersion,
        tasksUpdateSupported: record.tasks.updateSupported,
        notes: record.notes,
      },
    };
  }

  private async createTask(args: Record<string, unknown>): Promise<McpAppsTasksToolResult> {
    const serverName = asNonEmptyString(args['serverName']);
    const method = asNonEmptyString(args['method']);
    if (!serverName) return { ok: false, error: 'mcp_tasks_create cần "serverName".' };
    if (!method) return { ok: false, error: 'mcp_tasks_create cần "method".' };
    const transport = this.transportFor(serverName);
    if (!transport) {
      return { ok: false, error: `Chưa có transport cho server "${serverName}" — đăng ký transport trước khi tạo task.` };
    }
    const negotiation = this.negotiator.get(serverName);
    if (negotiation && negotiation.tasks.level === 'none') {
      return { ok: false, error: `Server "${serverName}" không hỗ trợ Tasks — chạy tool đồng bộ thay vì tạo task.` };
    }
    const params = isRecord(args['params']) ? args['params'] : {};
    const specVersion =
      args['specVersion'] === '2025-11-25' || args['specVersion'] === '2026-07-28'
        ? (args['specVersion'] as McpTaskSpecVersion)
        : '2026-07-28';
    const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined;
    const maxAttempts = typeof args['maxAttempts'] === 'number' ? Math.max(0, Math.floor(args['maxAttempts'])) : undefined;
    const outcome = await this.runner.run(transport, method, params, {
      specVersion,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxAttempts !== undefined ? { retry: { maxAttempts, baseDelayMs: 500, maxDelayMs: 8000 } } : {}),
    });
    return {
      ok: outcome.status === 'completed',
      data: {
        taskId: outcome.taskId,
        status: outcome.status,
        attempts: outcome.attempts,
        polls: outcome.polls,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      ...(outcome.status === 'completed' ? {} : { error: outcome.error ?? `Task kết thúc với trạng thái "${outcome.status}".` }),
    };
  }

  private cancelTask(args: Record<string, unknown>): McpAppsTasksToolResult {
    const taskId = asNonEmptyString(args['taskId']);
    if (!taskId) return { ok: false, error: 'mcp_tasks_cancel cần "taskId".' };
    const cancelled = this.runner.cancel(taskId);
    return {
      ok: cancelled,
      ...(cancelled ? { data: { taskId, cancelled: true } } : { error: `Không có task đang chạy nào với taskId "${taskId}".` }),
    };
  }

  private async resumeTasks(args: Record<string, unknown>): Promise<McpAppsTasksToolResult> {
    const serverName = asNonEmptyString(args['serverName']);
    if (!serverName) return { ok: false, error: 'mcp_tasks_resume cần "serverName".' };
    const transport = this.transportFor(serverName);
    if (!transport) {
      return { ok: false, error: `Chưa có transport cho server "${serverName}" — đăng ký transport trước khi resume.` };
    }
    if (!Array.isArray(args['tasks'])) {
      return { ok: false, error: 'mcp_tasks_resume cần "tasks" là danh sách task đã lưu.' };
    }
    const descriptors: ResumableTaskDescriptor[] = [];
    for (const raw of args['tasks'] as unknown[]) {
      if (!isRecord(raw)) continue;
      const taskId = asNonEmptyString(raw['taskId']);
      if (!taskId) continue;
      descriptors.push({
        taskId,
        serverName,
        method: asNonEmptyString(raw['method']) ?? 'tools/call',
        label: asNonEmptyString(raw['label']) ?? taskId,
        ...(raw['specVersion'] === '2025-11-25' || raw['specVersion'] === '2026-07-28'
          ? { specVersion: raw['specVersion'] as McpTaskSpecVersion }
          : {}),
        ...(typeof raw['pollIntervalMs'] === 'number' ? { pollIntervalMs: raw['pollIntervalMs'] } : {}),
      });
    }
    if (descriptors.length === 0) {
      return { ok: false, error: 'Không có task hợp lệ nào để resume.' };
    }
    const outcomes = await this.runner.resumeAll(transport, descriptors);
    return {
      ok: true,
      data: {
        resumed: outcomes.filter((o) => o.status === 'completed').length,
        orphaned: outcomes.filter((o) => o.error?.includes('orphaned')).length,
        outcomes: outcomes.map((o) => ({ taskId: o.taskId, status: o.status, error: o.error })),
      },
    };
  }
}

/** Helper nhanh: lấy definitions để đăng ký vào registry của agent. */
export function getMcpAppsTasksToolDefinitions(): ToolDefinition[] {
  return [...MCP_APPS_TASKS_TOOL_DEFINITIONS];
}
