/**
 * MCP Apps v2 + Tasks — capability negotiation hai chiều (v1.14, Đội T2).
 *
 * Spec 2026-07-28 (MCP 2.0, core stateless): không còn handshake
 * `initialize` — mỗi request mang protocol version + capabilities trong
 * `_meta`, và extension chỉ bật khi CẢ HAI phía đều khai báo (opt-in hai
 * chiều). Module v1.09 (`capabilityNegotiation.ts`) chỉ đàm phán một chiều
 * từ `initialize` result của server; module này là lớp v2 nối trên nó:
 *
 *   - Client khai báo extension trong `_meta.extensions`:
 *     `buildClientExtensions()` / `buildClientMetaExtensions()` — Apps
 *     (`io.modelcontextprotocol/ui`, stable) và Tasks
 *     (`io.modelcontextprotocol/tasks`, beta) kèm chi tiết từng mảnh
 *     (uiResources / templates / bridgeToolCalls / permissions,
 *     tasks/update / server-directed).
 *   - Server khai báo trong `server/discover` result: `extensions[]`
 *     (xem `stateless.ts: ServerDiscoverResult`) và/hoặc `_meta.extensions`
 *     và/hoặc `capabilities` — `parseServerExtensions()` chấp nhận cả ba
 *     dạng, kể cả tên legacy `io.modelcontextprotocol/apps`.
 *   - `negotiateExtensionsV2()` giao nhau hai phía: extension chỉ
 *     `enabled` khi client VÀ server đều khai báo; mức `full` /
 *     `partial` / `none` tính theo mảnh đã khai báo; mọi trường hợp
 *     thiếu đều có fallback plan ghi rõ bằng tiếng Việt (không im lặng).
 *   - `CapabilityNegotiatorV2` giữ record theo server, nối với
 *     `CapabilityNegotiator` v1.09 để tái dùng downgrade theo method
 *     (`-32601 Method not found`) và snapshot cho renderer.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import {
  CapabilityNegotiator,
  parseAppsSupport,
  parseTasksSupport,
  type ExtensionSupportLevel,
  type ServerNegotiation,
} from './capabilityNegotiation';
import { MCP_TASKS_EXTENSION_2026 } from './tasksSpec';
import type { McpTaskSpecVersion } from './tasks';

/** Extension Apps ổn định ở spec 2026-07-28 (`io.modelcontextprotocol/ui`). */
export const MCP_APPS_EXTENSION_2026 = 'io.modelcontextprotocol/ui';

/** Tên Apps legacy (v1.04 trở về trước) — vẫn chấp nhận khi parse. */
export const MCP_APPS_EXTENSION_LEGACY = 'io.modelcontextprotocol/apps';

/** Mọi extension đàm phán được ở lớp v2. */
export const MCP_V2_EXTENSIONS = [
  MCP_APPS_EXTENSION_2026,
  MCP_TASKS_EXTENSION_2026,
] as const;
export type McpV2ExtensionName = (typeof MCP_V2_EXTENSIONS)[number];

/**
 * Một extension khai báo trong `_meta.extensions` — dạng mà cả client
 * (trong request) và server (trong `server/discover` result) đều dùng.
 */
export interface MetaExtensionDeclaration {
  /** Tên extension, vd `io.modelcontextprotocol/ui`. */
  name: string;
  /** Version extension (mặc định `2026-07-28` khi vắng). */
  version?: string;
  /** Chi tiết từng mảnh — shape tự do, parse theo từng extension. */
  capabilities?: Record<string, unknown>;
}

/** Chi tiết Apps mà client khai báo. */
export interface ClientAppsDeclaration {
  /** Client render được resource `ui://` trong iframe sandboxed. */
  uiResources?: boolean;
  /** Client render được template + data (`uiTemplate`). */
  templates?: boolean;
  /** Client nhận tool-call từ app qua bridge. */
  bridgeToolCalls?: boolean;
  /** Client xin được quyền mic/camera cho app (v2 permissions). */
  mediaPermissions?: boolean;
}

/** Chi tiết Tasks mà client khai báo. */
export interface ClientTasksDeclaration {
  /** Client poll `tasks/get` (long-polling) thay vì chờ đồng bộ. */
  polling?: boolean;
  /** Client gửi input giữa chừng qua `tasks/update`. */
  update?: boolean;
  /** Client nhận task do server tự tạo (server-directed). */
  serverDirected?: boolean;
}

/** Toàn bộ extension client muốn bật (opt-in phía client). */
export interface ClientExtensionDeclaration {
  apps?: ClientAppsDeclaration | boolean;
  tasks?: ClientTasksDeclaration | boolean;
  /** Extension khác (tên đầy đủ) client tự khai thêm. */
  extra?: string[];
}

/** Một phía (client hoặc server) đã khai báo extension nào. */
export interface ExtensionSideDeclaration {
  apps: boolean;
  tasks: boolean;
  /** Tên extension thô phía đó khai báo (đã chuẩn hoá). */
  names: string[];
}

/** Kết quả đàm phán cho một extension (sau khi giao nhau hai phía). */
export interface NegotiatedExtensionV2 {
  /** Tên extension chuẩn 2026-07-28. */
  name: McpV2ExtensionName;
  /** Chỉ true khi CẢ client VÀ server đều khai báo. */
  enabled: boolean;
  level: ExtensionSupportLevel;
  clientDeclared: boolean;
  serverDeclared: boolean;
  /** Mảnh nào của extension thực sự dùng được (giao nhau hai phía). */
  effectivePieces: string[];
  /** Mảnh client muốn nhưng server không có (hoặc ngược lại). */
  missingPieces: string[];
  /** Fallback khi extension tắt hoặc thiếu mảnh (tiếng Việt). */
  fallback: string;
}

/** Kết quả đàm phán hai chiều đầy đủ cho một server. */
export interface ExtensionNegotiationV2 {
  serverName: string;
  protocolVersion: string;
  apps: NegotiatedExtensionV2;
  tasks: NegotiatedExtensionV2;
  /** Tasks spec version hiệu lực (theo protocol version đã chốt). */
  tasksSpecVersion: McpTaskSpecVersion;
  /** Ghi chú fallback / cảnh báo cho UI (tiếng Việt). */
  notes: string[];
  negotiatedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeExtensionName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (trimmed === MCP_APPS_EXTENSION_LEGACY) return MCP_APPS_EXTENSION_2026;
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Chuẩn hoá danh sách extension thô (string hoặc `{ name }`) thành tên
 * chuẩn — legacy `io.modelcontextprotocol/apps` gộp về
 * `io.modelcontextprotocol/ui`.
 */
export function normalizeExtensionNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name =
      typeof entry === 'string'
        ? normalizeExtensionName(entry)
        : isRecord(entry)
          ? normalizeExtensionName(entry['name'])
          : undefined;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Build khối `_meta.extensions` client gửi kèm mỗi request stateless.
 * Chỉ liệt kê extension client THẬT SỰ hỗ trợ — opt-in phía client.
 * Mặc định bật đủ Apps + Tasks (đầy đủ mảnh); truyền `false` để tắt.
 */
export function buildClientMetaExtensions(
  declaration: ClientExtensionDeclaration = {},
): MetaExtensionDeclaration[] {
  const extensions: MetaExtensionDeclaration[] = [];
  const apps = declaration.apps ?? true;
  if (apps !== false) {
    const caps: Record<string, unknown> = {};
    if (apps === true || apps.uiResources !== false) caps['uiResources'] = true;
    if (apps === true || apps.templates !== false) caps['templates'] = true;
    if (apps === true || apps.bridgeToolCalls !== false) caps['bridgeToolCalls'] = true;
    if (apps !== true && apps.mediaPermissions === true) caps['mediaPermissions'] = true;
    extensions.push({
      name: MCP_APPS_EXTENSION_2026,
      version: '2026-07-28',
      capabilities: caps,
    });
  }
  const tasks = declaration.tasks ?? true;
  if (tasks !== false) {
    const caps: Record<string, unknown> = {};
    if (tasks === true || tasks.polling !== false) caps['polling'] = true;
    if (tasks === true || tasks.update !== false) caps['update'] = true;
    if (tasks !== true && tasks.serverDirected === true) caps['serverDirected'] = true;
    extensions.push({
      name: MCP_TASKS_EXTENSION_2026,
      version: '2026-07-28',
      capabilities: caps,
    });
  }
  for (const extra of declaration.extra ?? []) {
    const name = normalizeExtensionName(extra);
    if (name && !extensions.some((e) => e.name === name)) {
      extensions.push({ name, version: '2026-07-28' });
    }
  }
  return extensions;
}

/** Tóm tắt phía client đã khai báo gì (để giao nhau với server). */
export function describeClientExtensions(
  declaration: ClientExtensionDeclaration = {},
): ExtensionSideDeclaration {
  const meta = buildClientMetaExtensions(declaration);
  const names = meta.map((e) => e.name);
  return {
    apps: names.includes(MCP_APPS_EXTENSION_2026),
    tasks: names.includes(MCP_TASKS_EXTENSION_2026),
    names,
  };
}

/**
 * Parse extension server khai báo từ `server/discover` result. Chấp nhận:
 *   - `extensions: [...]` ở root (xem `stateless.ts`).
 *   - `_meta.extensions: [...]` trong result.
 *   - `capabilities.extensions: [...]` hoặc `capabilities.apps` /
 *     `capabilities.tasks` (dạng `initialize` legacy).
 * Tên legacy `io.modelcontextprotocol/apps` được chuẩn hoá về `ui`.
 */
export function parseServerExtensions(discoverResult: unknown): ExtensionSideDeclaration {
  const result = isRecord(discoverResult) ? discoverResult : {};
  const names = new Set<string>();
  for (const raw of normalizeExtensionNames(result['extensions'])) names.add(raw);
  const meta = isRecord(result['_meta']) ? result['_meta'] : undefined;
  if (meta) {
    for (const raw of normalizeExtensionNames(meta['extensions'])) names.add(raw);
  }
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : undefined;
  if (capabilities) {
    for (const raw of normalizeExtensionNames(capabilities['extensions'])) names.add(raw);
    // Dạng capabilities.apps / .tasks = true hoặc object cũng tính là khai báo.
    if (capabilities['apps'] !== undefined) names.add(MCP_APPS_EXTENSION_2026);
    if (capabilities['tasks'] !== undefined) names.add(MCP_TASKS_EXTENSION_2026);
    const experimental = isRecord(capabilities['experimental']) ? capabilities['experimental'] : undefined;
    if (experimental) {
      if (asBool(experimental['apps']) === true) names.add(MCP_APPS_EXTENSION_2026);
      if (asBool(experimental['tasks']) === true) names.add(MCP_TASKS_EXTENSION_2026);
    }
  }
  const list = [...names];
  return {
    apps: list.includes(MCP_APPS_EXTENSION_2026),
    tasks: list.includes(MCP_TASKS_EXTENSION_2026),
    names: list,
  };
}

/**
 * Chi tiết từng mảnh Apps server khai báo (để giao nhau với client).
 * Đọc từ `capabilities.apps` khi có; không có thì mặc định server chỉ
 * có `uiResources` (mảnh tối thiểu của Apps).
 */
export function parseServerAppsPieces(discoverResult: unknown): {
  uiResources: boolean;
  templates: boolean;
  bridgeToolCalls: boolean;
  mediaPermissions: boolean;
} {
  const result = isRecord(discoverResult) ? discoverResult : {};
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : undefined;
  const appsField = capabilities?.['apps'];
  const parsed = parseAppsSupport(capabilities ?? {});
  const meta = isRecord(result['_meta']) ? result['_meta'] : undefined;
  const metaExt = Array.isArray(meta?.['extensions'])
    ? (meta['extensions'] as unknown[]).find(
        (e) =>
          isRecord(e) &&
          normalizeExtensionName(e['name']) === MCP_APPS_EXTENSION_2026,
      )
    : undefined;
  const metaCaps = isRecord(metaExt) && isRecord(metaExt['capabilities']) ? metaExt['capabilities'] : undefined;
  const media =
    (isRecord(appsField) ? asBool(appsField['mediaPermissions']) : undefined) ??
    (metaCaps ? asBool(metaCaps['mediaPermissions']) : undefined) ??
    false;
  return {
    uiResources: parsed.uiResources,
    templates: parsed.templates,
    bridgeToolCalls: parsed.bridgeToolCalls,
    mediaPermissions: media,
  };
}

/** Chi tiết từng mảnh Tasks server khai báo (để giao nhau với client). */
export function parseServerTasksPieces(
  discoverResult: unknown,
  protocolVersion: string,
): { polling: boolean; update: boolean; serverDirected: boolean } {
  const result = isRecord(discoverResult) ? discoverResult : {};
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : undefined;
  const parsed = parseTasksSupport(capabilities ?? {}, protocolVersion);
  return {
    polling: parsed.level !== 'none',
    update: parsed.updateSupported,
    serverDirected: parsed.serverDirected,
  };
}

const APPS_PIECE_LABELS: Record<string, string> = {
  uiResources: 'resource ui://',
  templates: 'template + data',
  bridgeToolCalls: 'tool-call qua bridge',
  mediaPermissions: 'quyền mic/camera cho app',
};

const TASKS_PIECE_LABELS: Record<string, string> = {
  polling: 'poll tasks/get',
  update: 'tasks/update gửi input',
  serverDirected: 'task do server tự tạo',
};

function negotiateOne(
  name: McpV2ExtensionName,
  clientDeclared: boolean,
  serverDeclared: boolean,
  clientPieces: Record<string, boolean>,
  serverPieces: Record<string, boolean>,
  labels: Record<string, string>,
  fallbackText: string,
): NegotiatedExtensionV2 {
  const enabled = clientDeclared && serverDeclared;
  const effectivePieces: string[] = [];
  const missingPieces: string[] = [];
  for (const piece of Object.keys(labels)) {
    const wanted = clientPieces[piece] === true;
    const offered = serverPieces[piece] === true;
    if (wanted && offered) effectivePieces.push(piece);
    else if (wanted && !offered) missingPieces.push(piece);
  }
  let level: ExtensionSupportLevel = 'none';
  if (enabled) {
    level = missingPieces.length === 0 ? 'full' : 'partial';
  }
  return {
    name,
    enabled,
    level,
    clientDeclared,
    serverDeclared,
    effectivePieces,
    missingPieces,
    fallback: enabled
      ? missingPieces.length === 0
        ? ''
        : `Thiếu: ${missingPieces.map((p) => labels[p]).join(', ')} — ${fallbackText}`
      : fallbackText,
  };
}

/**
 * Đàm phán hai chiều đầy đủ: giao nhau client declaration với server
 * discover result. Extension chỉ bật khi cả hai phía khai báo; mọi
 * mảnh thiếu đều liệt kê trong `missingPieces` + `notes`.
 */
export function negotiateExtensionsV2(
  serverName: string,
  clientDeclaration: ClientExtensionDeclaration,
  discoverResult: unknown,
  protocolVersion = '2026-07-28',
  nowMs = Date.now(),
): ExtensionNegotiationV2 {
  const client = describeClientExtensions(clientDeclaration);
  const server = parseServerExtensions(discoverResult);
  const appsDecl = clientDeclaration.apps;
  const tasksDecl = clientDeclaration.tasks;
  const appsPiece = (key: keyof ClientAppsDeclaration): boolean => {
    if (appsDecl === false) return false;
    if (appsDecl === undefined || appsDecl === true) return true;
    return appsDecl[key] !== false;
  };
  const clientAppsPieces = {
    uiResources: appsPiece('uiResources'),
    templates: appsPiece('templates'),
    bridgeToolCalls: appsPiece('bridgeToolCalls'),
    mediaPermissions:
      appsDecl !== false && appsDecl !== undefined && appsDecl !== true && appsDecl.mediaPermissions === true,
  };
  const tasksPiece = (key: keyof ClientTasksDeclaration): boolean => {
    if (tasksDecl === false) return false;
    if (tasksDecl === undefined || tasksDecl === true) return true;
    return tasksDecl[key] !== false;
  };
  const clientTasksPieces = {
    polling: tasksPiece('polling'),
    update: tasksPiece('update'),
    serverDirected:
      tasksDecl !== false && tasksDecl !== undefined && tasksDecl !== true && tasksDecl.serverDirected === true,
  };
  const apps = negotiateOne(
    MCP_APPS_EXTENSION_2026,
    client.apps,
    server.apps,
    clientAppsPieces,
    parseServerAppsPieces(discoverResult),
    APPS_PIECE_LABELS,
    'Tool trả kết quả text thường, không có UI tương tác.',
  );
  const tasks = negotiateOne(
    MCP_TASKS_EXTENSION_2026,
    client.tasks,
    server.tasks,
    clientTasksPieces,
    parseServerTasksPieces(discoverResult, protocolVersion),
    TASKS_PIECE_LABELS,
    'Tool dài chạy đồng bộ, client chờ trực tiếp thay vì poll nền.',
  );
  const tasksSpecVersion: McpTaskSpecVersion =
    protocolVersion === '2026-07-28' ? '2026-07-28' : '2025-11-25';
  const notes: string[] = [];
  if (!client.apps && !server.apps) {
    notes.push('Cả client và server đều không khai báo MCP Apps — chỉ dùng kết quả text.');
  } else if (!client.apps) {
    notes.push('Client không khai báo MCP Apps — app từ server sẽ hiển thị dạng text.');
  } else if (!server.apps) {
    notes.push('Server không khai báo MCP Apps — tool trả kết quả text thường, không có UI tương tác.');
  } else if (apps.level === 'partial') {
    notes.push(`MCP Apps chỉ dùng được một phần — ${apps.fallback}`);
  }
  if (!client.tasks && !server.tasks) {
    notes.push('Cả client và server đều không khai báo Tasks — chỉ chạy tool đồng bộ.');
  } else if (!client.tasks) {
    notes.push('Client không khai báo Tasks — tool dài chạy đồng bộ thay vì poll nền.');
  } else if (!server.tasks) {
    notes.push('Server không khai báo Tasks — tool dài chạy đồng bộ, client chờ trực tiếp thay vì poll nền.');
  } else if (tasks.level === 'partial') {
    notes.push(`Tasks chỉ dùng được một phần — ${tasks.fallback}`);
  }
  if (tasksSpecVersion === '2025-11-25' && tasks.enabled) {
    notes.push('Tasks đang nói bản 2025-11-25 — lấy kết quả qua tasks/result, không gửi được input giữa chừng.');
  }
  return { serverName, protocolVersion, apps, tasks, tasksSpecVersion, notes, negotiatedAtMs: nowMs };
}

/**
 * Fallback matrix cho một tool call dựa trên đàm phán v2: tool cần gì
 * (app? task?) và đàm phán cho phép gì. Trả quyết định + lý do để UI
 * giải thích thay vì im lặng.
 */
export function fallbackMatrixV2(
  negotiation: ExtensionNegotiationV2,
  needs: { app?: boolean; task?: boolean },
): {
  renderApp: boolean;
  runAsTask: boolean;
  useTemplate: boolean;
  useBridge: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  let renderApp = false;
  let runAsTask = false;
  let useTemplate = false;
  let useBridge = false;
  if (needs.app) {
    if (!negotiation.apps.enabled) {
      reasons.push('MCP Apps chưa đàm phán xong hai chiều — hiển thị kết quả dạng text.');
    } else {
      renderApp = true;
      useTemplate = negotiation.apps.effectivePieces.includes('templates');
      useBridge = negotiation.apps.effectivePieces.includes('bridgeToolCalls');
      if (negotiation.apps.level === 'partial') {
        reasons.push(`MCP Apps chỉ dùng được một phần — thiếu: ${negotiation.apps.missingPieces.join(', ')}.`);
      }
    }
  }
  if (needs.task) {
    if (!negotiation.tasks.enabled) {
      reasons.push('Tasks chưa đàm phán xong hai chiều — chạy tool đồng bộ.');
    } else {
      runAsTask = true;
      if (negotiation.tasks.level === 'partial') {
        reasons.push(`Tasks chỉ dùng được một phần — thiếu: ${negotiation.tasks.missingPieces.join(', ')}.`);
      }
    }
  }
  return { renderApp, runAsTask, useTemplate, useBridge, reasons };
}

/** Snapshot v2 cho renderer (gộp cả đàm phán v1.09 bên dưới). */
export interface NegotiationV2Snapshot {
  serverName: string;
  protocolVersion: string;
  appsEnabled: boolean;
  appsLevel: ExtensionSupportLevel;
  tasksEnabled: boolean;
  tasksLevel: ExtensionSupportLevel;
  tasksSpecVersion: McpTaskSpecVersion;
  effectiveAppsPieces: string[];
  effectiveTasksPieces: string[];
  notes: string[];
  downgradedMethods: string[];
}

/**
 * Registry đàm phán v2 cho mọi MCP server. Nối với `CapabilityNegotiator`
 * v1.09 (đàm phán `initialize` + downgrade `-32601`) và thêm lớp
 * stateless hai chiều (`server/discover` + `_meta.extensions`).
 */
export class CapabilityNegotiatorV2 {
  private readonly records = new Map<string, ExtensionNegotiationV2>();
  private readonly legacy: CapabilityNegotiator;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.legacy = new CapabilityNegotiator({ now: this.now });
  }

  /** Đàm phán stateless hai chiều từ `server/discover` result. */
  negotiateStateless(
    serverName: string,
    clientDeclaration: ClientExtensionDeclaration,
    discoverResult: unknown,
    protocolVersion = '2026-07-28',
  ): ExtensionNegotiationV2 {
    const record = negotiateExtensionsV2(
      serverName,
      clientDeclaration,
      discoverResult,
      protocolVersion,
      this.now(),
    );
    this.records.set(serverName, record);
    return record;
  }

  /** Đàm phán legacy từ `initialize` result (tái dùng v1.09). */
  negotiateLegacy(serverName: string, initializeResult: unknown): ServerNegotiation {
    return this.legacy.negotiate(serverName, initializeResult);
  }

  get(serverName: string): ExtensionNegotiationV2 | undefined {
    return this.records.get(serverName);
  }

  list(): ExtensionNegotiationV2[] {
    return [...this.records.values()];
  }

  /** Ghi nhận method bị server từ chối — hạ mức, lần sau không gọi nữa. */
  recordMethodNotFound(serverName: string, method: string, reason = 'Method not found'): void {
    this.legacy.recordMethodNotFound(serverName, method, reason);
    const record = this.records.get(serverName);
    if (record && (method === 'tasks/get' || method === 'tasks/update')) {
      if (record.tasks.level === 'full') record.tasks.level = 'partial';
      if (method === 'tasks/update' && !record.tasks.missingPieces.includes('update')) {
        record.tasks.missingPieces.push('update');
      }
      record.notes.push(`Server từ chối ${method} — đã hạ hỗ trợ Tasks, lần sau không gọi method này nữa.`);
    }
  }

  isDowngraded(serverName: string, method: string): boolean {
    return this.legacy.isDowngraded(serverName, method);
  }

  snapshot(serverName: string): NegotiationV2Snapshot | undefined {
    const record = this.records.get(serverName);
    if (!record) return undefined;
    return {
      serverName: record.serverName,
      protocolVersion: record.protocolVersion,
      appsEnabled: record.apps.enabled,
      appsLevel: record.apps.level,
      tasksEnabled: record.tasks.enabled,
      tasksLevel: record.tasks.level,
      tasksSpecVersion: record.tasksSpecVersion,
      effectiveAppsPieces: [...record.apps.effectivePieces],
      effectiveTasksPieces: [...record.tasks.effectivePieces],
      notes: [...record.notes],
      downgradedMethods: this.legacy.downgradedMethods(serverName).map((d) => d.method),
    };
  }

  snapshots(): NegotiationV2Snapshot[] {
    return [...this.records.keys()]
      .map((name) => this.snapshot(name)!)
      .filter(Boolean);
  }

  remove(serverName: string): boolean {
    this.legacy.remove(serverName);
    return this.records.delete(serverName);
  }
}
