/**
 * MCP Apps + Tasks — capability negotiation (v1.09, Team T3).
 *
 * Các module trước đã có đàm phán protocol version (`client.ts`
 * `negotiateProtocolVersion`) và gating tasks theo spec version
 * (`tasksSpec.ts`), nhưng chưa có nơi nào trả lời câu hỏi ở tầng
 * SẢN PHẨM: "server này hỗ trợ Apps? Tasks? Ở mức nào? Và khi
 * không hỗ trợ thì client fallback ra sao?". Module này là nơi đó:
 *
 *   - Parse `capabilities` từ `initialize` result của server
 *     (dạng chuẩn MCP 2026-07-28: `capabilities.apps`,
 *     `capabilities.tasks`, cùng các dạng legacy mà server cũ hay
 *     trả: `experimental: { apps: true }`, `extensions: [...]`).
 *   - Quyết định mức hỗ trợ từng extension:
 *       `full` (khai báo rõ + đúng spec 2026-07-28),
 *       `partial` (khai báo nhưng thiếu mảnh — vd tasks có nhưng
 *       không có `tasks/update`, apps có nhưng không có resource
 *       `ui://`),
 *       `none` (không khai báo).
 *   - Fallback plan: khi `none` thì tool call chạy thường (không
 *     UI, không task dài — client tự poll ngắn / chờ đồng bộ);
 *     khi `partial` thì chỉ dùng đúng mảnh đã khai báo, phần còn
 *     lại fallback; mọi fallback đều được ghi rõ trong `notes`
 *     để UI giải thích cho user thay vì im lặng.
 *   - Downgrade khi lỗi: server khai báo hỗ trợ nhưng trả
 *     `-32601 Method not found` khi gọi -> ghi lại, hạ mức hỗ trợ
 *     của method đó, lần sau không gọi nữa (tránh spam lỗi).
 *   - Registry per-server: `CapabilityNegotiator` giữ record của
 *     mọi server đã đàm phán, cho phép re-negotiate sau khi server
 *     reconnect, và export snapshot để renderer hiện trạng thái.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import type { McpTaskSpecVersion } from './tasks';
import { MCP_APPS_EXTENSION } from './apps';
import { MCP_TASKS_EXTENSION_2026 } from './tasksSpec';

/** Mức hỗ trợ của một extension trên một server. */
export type ExtensionSupportLevel = 'full' | 'partial' | 'none';

/** Tên extension đàm phán. */
export type NegotiatedExtension = 'apps' | 'tasks';

/** Chi tiết hỗ trợ Apps của một server. */
export interface AppsSupport {
  level: ExtensionSupportLevel;
  /** Server có trả resource `ui://` không. */
  uiResources: boolean;
  /** Server có trả template + data (`uiTemplate`) không. */
  templates: boolean;
  /** Server có nhận tool-call qua bridge không. */
  bridgeToolCalls: boolean;
  /** Extension name server khai báo (nếu có). */
  extensionName?: string;
}

/** Chi tiết hỗ trợ Tasks của một server. */
export interface TasksSupport {
  level: ExtensionSupportLevel;
  /** Spec version tasks server nói (2026-07-28 = extension chính thức). */
  specVersion: McpTaskSpecVersion;
  /** `tasks/get` có trả kết quả cuối không (chỉ 2026). */
  getReturnsResult: boolean;
  /** `tasks/update` gửi input được không (chỉ 2026). */
  updateSupported: boolean;
  /** `tasks/list` còn không (chỉ 2025 legacy). */
  listSupported: boolean;
  /** Server có tự tạo task (server-directed, `tasks/create`) không. */
  serverDirected: boolean;
  extensionName?: string;
}

/** Kết quả đàm phán cho một server. */
export interface ServerNegotiation {
  serverName: string;
  protocolVersion?: string;
  apps: AppsSupport;
  tasks: TasksSupport;
  /** Ghi chú fallback / cảnh báo cho UI (tiếng Việt). */
  notes: string[];
  negotiatedAtMs: number;
}

/** Method tasks đã bị downgrade vì server trả Method not found. */
export interface DowngradedMethod {
  method: string;
  atMs: number;
  reason: string;
}

/** Snapshot hiển thị cho renderer. */
export interface NegotiationSnapshot {
  serverName: string;
  protocolVersion?: string;
  appsLevel: ExtensionSupportLevel;
  tasksLevel: ExtensionSupportLevel;
  tasksSpecVersion: McpTaskSpecVersion;
  notes: string[];
  downgradedMethods: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Tìm extension name trong `capabilities.extensions` (nếu server dùng dạng đó). */
function findExtension(capabilities: Record<string, unknown>, name: string): boolean {
  const extensions = capabilities['extensions'];
  if (Array.isArray(extensions)) {
    return extensions.some((e) => e === name || (isRecord(e) && e['name'] === name));
  }
  return false;
}

/**
 * Parse hỗ trợ Apps từ capabilities của server. Chấp nhận:
 *  - `capabilities.apps = { uiResources, templates, bridgeToolCalls }`
 *  - `capabilities.apps = true` (khai báo tối thiểu -> partial)
 *  - `capabilities.experimental.apps = true`
 *  - `capabilities.extensions` chứa `io.modelcontextprotocol/apps`
 */
export function parseAppsSupport(capabilities: unknown): AppsSupport {
  const base: AppsSupport = { level: 'none', uiResources: false, templates: false, bridgeToolCalls: false };
  if (!isRecord(capabilities)) return base;
  const appsField = capabilities['apps'];
  const experimental = isRecord(capabilities['experimental']) ? capabilities['experimental'] : undefined;
  const extDeclared =
    findExtension(capabilities, MCP_APPS_EXTENSION) || findExtension(capabilities, 'apps');
  if (appsField === true || asBool(experimental?.['apps']) === true || extDeclared) {
    base.level = 'partial';
    base.uiResources = true;
    if (extDeclared) base.extensionName = MCP_APPS_EXTENSION;
  }
  if (isRecord(appsField)) {
    const ui = asBool(appsField['uiResources']);
    const tpl = asBool(appsField['templates']);
    const bridge = asBool(appsField['bridgeToolCalls']);
    base.uiResources = ui ?? base.uiResources;
    base.templates = tpl ?? false;
    base.bridgeToolCalls = bridge ?? false;
    if (typeof appsField['extension'] === 'string') base.extensionName = appsField['extension'];
    const declared = ui !== false || tpl === true || bridge === true || extDeclared;
    if (declared) {
      base.level = base.uiResources && base.templates && base.bridgeToolCalls ? 'full' : 'partial';
    }
  }
  return base;
}

/**
 * Parse hỗ trợ Tasks từ capabilities + protocol version. Chấp nhận:
 *  - `capabilities.tasks = { specVersion, update, list, serverDirected }`
 *  - `capabilities.tasks = true` (mặc định theo protocol version)
 *  - `capabilities.experimental.tasks = true`
 *  - `capabilities.extensions` chứa `io.modelcontextprotocol/tasks`
 */
export function parseTasksSupport(capabilities: unknown, protocolVersion?: string): TasksSupport {
  const is2026 = protocolVersion === '2026-07-28';
  const base: TasksSupport = {
    level: 'none',
    specVersion: is2026 ? '2026-07-28' : '2025-11-25',
    getReturnsResult: is2026,
    updateSupported: is2026,
    listSupported: !is2026,
    serverDirected: false,
  };
  if (!isRecord(capabilities)) return base;
  const tasksField = capabilities['tasks'];
  const experimental = isRecord(capabilities['experimental']) ? capabilities['experimental'] : undefined;
  const extDeclared = findExtension(capabilities, MCP_TASKS_EXTENSION_2026) || findExtension(capabilities, 'tasks');
  if (tasksField === true || asBool(experimental?.['tasks']) === true || extDeclared) {
    base.level = is2026 ? 'full' : 'partial';
    if (extDeclared) base.extensionName = MCP_TASKS_EXTENSION_2026;
  }
  if (isRecord(tasksField)) {
    const spec = tasksField['specVersion'];
    if (spec === '2026-07-28' || spec === '2025-11-25') {
      base.specVersion = spec;
      base.getReturnsResult = spec === '2026-07-28';
      base.updateSupported = spec === '2026-07-28';
      base.listSupported = spec === '2025-11-25';
    }
    const update = asBool(tasksField['update']);
    if (update !== undefined) base.updateSupported = update;
    const list = asBool(tasksField['list']);
    if (list !== undefined) base.listSupported = list;
    const directed = asBool(tasksField['serverDirected']);
    if (directed !== undefined) base.serverDirected = directed;
    if (typeof tasksField['extension'] === 'string') base.extensionName = tasksField['extension'];
    const declared = true;
    if (declared) {
      base.level =
        base.specVersion === '2026-07-28' && base.updateSupported && !base.listSupported ? 'full' : 'partial';
    }
  }
  return base;
}

/**
 * Đàm phán đầy đủ cho một server từ `initialize` result:
 * `{ protocolVersion, capabilities }`. Trả `ServerNegotiation`
 * kèm notes fallback bằng tiếng Việt.
 */
export function negotiateServerCapabilities(
  serverName: string,
  initializeResult: unknown,
  nowMs = Date.now(),
): ServerNegotiation {
  const result = isRecord(initializeResult) ? initializeResult : {};
  const protocolVersion =
    typeof result['protocolVersion'] === 'string' ? (result['protocolVersion'] as string) : undefined;
  const capabilities = result['capabilities'];
  const apps = parseAppsSupport(capabilities);
  const tasks = parseTasksSupport(capabilities, protocolVersion);
  const notes: string[] = [];
  if (apps.level === 'none') {
    notes.push('Server không hỗ trợ MCP Apps — tool trả kết quả text thường, không có UI tương tác.');
  } else if (apps.level === 'partial') {
    const missing: string[] = [];
    if (!apps.uiResources) missing.push('resource ui://');
    if (!apps.templates) missing.push('template + data');
    if (!apps.bridgeToolCalls) missing.push('tool-call qua bridge');
    notes.push(`Server hỗ trợ MCP Apps một phần — thiếu: ${missing.join(', ')}. Phần thiếu sẽ fallback về text.`);
  }
  if (tasks.level === 'none') {
    notes.push('Server không hỗ trợ Tasks — tool dài chạy đồng bộ, client chờ trực tiếp thay vì poll nền.');
  } else if (tasks.level === 'partial') {
    if (tasks.specVersion === '2025-11-25') {
      notes.push('Server dùng Tasks 2025-11-25 (experimental) — không gửi được input cho task input_required; lấy kết quả qua tasks/result.');
    } else if (!tasks.updateSupported) {
      notes.push('Server dùng Tasks 2026-07-28 nhưng không hỗ trợ tasks/update — task input_required sẽ dừng chờ thay vì gửi input.');
    }
  }
  if (tasks.serverDirected) {
    notes.push('Server có thể tự tạo task (server-directed) — client sẽ poll các task đó.');
  }
  return { serverName, protocolVersion, apps, tasks, notes, negotiatedAtMs: nowMs };
}

/**
 * Fallback cho một tool call khi server không hỗ trợ extension:
 *  - apps none: không render UI, trả text.
 *  - tasks none: chạy đồng bộ (không tạo task nền).
 *  - apps partial: chỉ render khi app dùng đúng mảnh đã hỗ trợ.
 */
export function fallbackForToolCall(
  negotiation: ServerNegotiation,
  needs: { app?: boolean; task?: boolean },
): { renderApp: boolean; runAsTask: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let renderApp = false;
  let runAsTask = false;
  if (needs.app) {
    if (negotiation.apps.level === 'none') {
      reasons.push('Server không hỗ trợ MCP Apps — hiển thị kết quả dạng text.');
    } else {
      renderApp = true;
      if (negotiation.apps.level === 'partial') {
        reasons.push('Server hỗ trợ Apps một phần — chỉ render UI dùng các mảnh đã khai báo.');
      }
    }
  }
  if (needs.task) {
    if (negotiation.tasks.level === 'none') {
      reasons.push('Server không hỗ trợ Tasks — chạy tool đồng bộ.');
    } else {
      runAsTask = true;
    }
  }
  return { renderApp, runAsTask, reasons };
}

/** JSON-RPC error code cho "method không tồn tại". */
export const MCP_METHOD_NOT_FOUND_CODE = -32601;

/** True khi lỗi transport mang mã Method not found. */
export function isMethodNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error['code'] === MCP_METHOD_NOT_FOUND_CODE) return true;
  const inner = error['error'];
  if (isRecord(inner) && inner['code'] === MCP_METHOD_NOT_FOUND_CODE) return true;
  return false;
}

/**
 * Registry đàm phán cho mọi MCP server đã kết nối. Giữ record +
 * downgrade theo method; renderer đọc snapshot để hiện trạng thái.
 */
export class CapabilityNegotiator {
  private readonly records = new Map<string, ServerNegotiation>();
  private readonly downgraded = new Map<string, DowngradedMethod[]>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Đàm phán (hoặc đàm phán lại) cho một server. */
  negotiate(serverName: string, initializeResult: unknown): ServerNegotiation {
    const record = negotiateServerCapabilities(serverName, initializeResult, this.now());
    this.records.set(serverName, record);
    // Re-negotiate thì xoá downgrade cũ: server mới có thể đã hỗ trợ lại.
    this.downgraded.delete(serverName);
    return record;
  }

  get(serverName: string): ServerNegotiation | undefined {
    return this.records.get(serverName);
  }

  list(): ServerNegotiation[] {
    return [...this.records.values()];
  }

  /** Ghi nhận một method bị server từ chối (Method not found) -> downgrade. */
  recordMethodNotFound(serverName: string, method: string, reason = 'Method not found'): void {
    const list = this.downgraded.get(serverName) ?? [];
    if (!list.some((d) => d.method === method)) {
      list.push({ method, atMs: this.now(), reason });
      this.downgraded.set(serverName, list);
    }
    const record = this.records.get(serverName);
    if (record) {
      // Hạ tasks xuống partial khi tasks/get hoặc tasks/update bị từ chối.
      if (method === 'tasks/get' || method === 'tasks/update') {
        record.tasks.level = record.tasks.level === 'full' ? 'partial' : record.tasks.level;
        if (method === 'tasks/update') record.tasks.updateSupported = false;
        record.notes.push(`Server từ chối ${method} — đã hạ hỗ trợ Tasks, lần sau không gọi method này nữa.`);
      }
    }
  }

  /** True khi method đã bị downgrade cho server này (không nên gọi lại). */
  isDowngraded(serverName: string, method: string): boolean {
    return (this.downgraded.get(serverName) ?? []).some((d) => d.method === method);
  }

  downgradedMethods(serverName: string): DowngradedMethod[] {
    return [...(this.downgraded.get(serverName) ?? [])];
  }

  /** Snapshot cho renderer. */
  snapshot(serverName: string): NegotiationSnapshot | undefined {
    const record = this.records.get(serverName);
    if (!record) return undefined;
    return {
      serverName: record.serverName,
      protocolVersion: record.protocolVersion,
      appsLevel: record.apps.level,
      tasksLevel: record.tasks.level,
      tasksSpecVersion: record.tasks.specVersion,
      notes: [...record.notes],
      downgradedMethods: this.downgradedMethods(serverName).map((d) => d.method),
    };
  }

  snapshots(): NegotiationSnapshot[] {
    return [...this.records.keys()]
      .map((name) => this.snapshot(name)!)
      .filter(Boolean);
  }

  remove(serverName: string): boolean {
    this.downgraded.delete(serverName);
    return this.records.delete(serverName);
  }
}
