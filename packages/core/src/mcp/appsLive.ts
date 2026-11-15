/**
 * MCP Apps — live template + data (v1.09, Team T3).
 *
 * `apps.ts` render HTML tĩnh: tool trả HTML xong là xong. Spec MCP
 * Apps 2026-07-28 cho phép tool trả kèm UI template + dữ liệu, và UI
 * cập nhật theo trạng thái tool call (đang chạy -> tiến độ -> xong).
 * Module này là lớp "live" trên nền đó:
 *
 *   - AppTemplate: HTML chứa placeholder `{{path.to.value}}`
 *     (vd `{{user.name}}`, `{{items.0.title}}`); dữ liệu là JSON
 *     thuần. Render = thay placeholder bằng giá trị đã escape HTML
 *     (không `eval`, không `new Function`, không chèn HTML thô từ
 *     dữ liệu — dữ liệu chứa `<script>` cũng chỉ hiện thành text).
 *   - Data patch: cập nhật từng phần dữ liệu bằng JSON Merge Patch
 *     (RFC 7386, tự implement — `null` xoá key); mỗi patch tăng
 *     `version`; patch có version <= version hiện tại bị từ chối
 *     (stale update — tránh race khi tool call chạy song song).
 *   - Tool-call status machine: `idle -> running -> progress* ->
 *     done | error | cancelled`; mỗi chuyển trạng thái hợp lệ mới
 *     được chấp nhận (vd `done -> running` là sai, trừ khi reset);
 *     host push trạng thái xuống app qua bridge (`app-status`).
 *   - App instance: một lần tool call có UI = một instance (id,
 *     template, data, version, status, history các lần update);
 *     instance hết hạn (TTL) thì host đóng frame.
 *   - Template discovery: tool khai báo `uiTemplate` trong
 *     `structuredContent` (`{ template, data, title, uri }`) hoặc
 *     resource `ui://` kèm `data` — `parseLiveAppResult` nhận cả
 *     hai dạng, trả về instance sẵn render hoặc lỗi rõ ràng.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import { validateAppHtml } from './apps';

export const APP_LIVE_MAX_DATA_BYTES = 64 * 1024;
export const APP_LIVE_MAX_PLACEHOLDERS = 500;
export const APP_LIVE_MAX_PATCH_DEPTH = 10;
export const APP_LIVE_MAX_HISTORY = 50;
/** TTL mặc định của một live app instance (ms) — 30 phút. */
export const APP_LIVE_DEFAULT_TTL_MS = 30 * 60_000;

export class AppLiveError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppLiveError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Escape HTML cho giá trị dữ liệu chèn vào template. */
export function escapeAppDataHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Đọc một path `a.b.0.c` từ dữ liệu JSON (object/array). */
export function readDataPath(data: unknown, path: string): unknown {
  const parts = path.split('.').filter((p) => p.length > 0);
  let current: unknown = data;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (isRecord(current)) {
      if (!(part in current)) return undefined;
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Liệt kê mọi placeholder `{{...}}` trong template (giữ thứ tự xuất hiện). */
export function listTemplatePlaceholders(template: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_.$]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const path = m[1].trim();
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * Render template với dữ liệu: placeholder có giá trị -> giá trị đã
 * escape; placeholder thiếu giá trị -> giữ nguyên `{{path}}` và ghi
 * vào `missing` (host có thể cảnh báo thay vì fail lặng).
 * Placeholder vượt quá giới hạn -> ném AppLiveError.
 */
export function renderAppTemplate(
  template: string,
  data: Record<string, unknown>,
): { html: string; missing: string[]; used: string[] } {
  const placeholders = listTemplatePlaceholders(template);
  if (placeholders.length > APP_LIVE_MAX_PLACEHOLDERS) {
    throw new AppLiveError(
      `Template có ${placeholders.length} placeholder, vượt giới hạn ${APP_LIVE_MAX_PLACEHOLDERS}.`,
      'too-many-placeholders',
    );
  }
  const missing: string[] = [];
  const used: string[] = [];
  const html = template.replace(/\{\{\s*([A-Za-z0-9_.$]+)\s*\}\}/g, (_whole, rawPath: string) => {
    const path = rawPath.trim();
    const value = readDataPath(data, path);
    if (value === undefined) {
      if (!missing.includes(path)) missing.push(path);
      return `{{${path}}}`;
    }
    used.push(path);
    if (value === null) return '';
    if (typeof value === 'object') return escapeAppDataHtml(JSON.stringify(value));
    return escapeAppDataHtml(String(value));
  });
  return { html, missing, used };
}

/**
 * JSON Merge Patch (RFC 7386): `patch` là object; key có giá trị
 * `null` -> xoá key đích; object lồng nhau -> merge đệ quy; các
 * giá trị khác -> thay thế. Array được thay thế nguyên (không merge
 * từng phần tử). Không mutate đầu vào.
 */
export function applyDataPatch(
  data: Record<string, unknown>,
  patch: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > APP_LIVE_MAX_PATCH_DEPTH) {
    throw new AppLiveError('Data patch lồng nhau quá sâu.', 'patch-too-deep');
  }
  const out: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isRecord(value) && isRecord(out[key])) {
      out[key] = applyDataPatch(out[key], value, depth + 1);
    } else if (isRecord(value)) {
      out[key] = applyDataPatch({}, value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Trạng thái của một tool call có UI. */
export type AppToolCallStatus = 'idle' | 'running' | 'progress' | 'done' | 'error' | 'cancelled';

/** Chuyển trạng thái hợp lệ (state machine). */
export const APP_TOOL_CALL_TRANSITIONS: Record<AppToolCallStatus, readonly AppToolCallStatus[]> = {
  idle: ['running', 'cancelled'],
  running: ['progress', 'done', 'error', 'cancelled'],
  progress: ['progress', 'done', 'error', 'cancelled'],
  done: [],
  error: [],
  cancelled: [],
};

/** True khi chuyển trạng thái được phép. */
export function canTransitionAppStatus(from: AppToolCallStatus, to: AppToolCallStatus): boolean {
  if (from === to && from === 'progress') return true;
  return (APP_TOOL_CALL_TRANSITIONS[from] as readonly AppToolCallStatus[]).includes(to);
}

/** True khi trạng thái là trạng thái cuối. */
export function isAppToolCallTerminal(status: AppToolCallStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

/** Một lần cập nhật dữ liệu / trạng thái của instance (để debug + audit). */
export interface AppLiveHistoryEntry {
  atMs: number;
  version: number;
  kind: 'data' | 'status' | 'created';
  status: AppToolCallStatus;
  progress?: number;
  message?: string;
}

/** Một live app instance: một tool call + UI của nó. */
export interface AppLiveInstance {
  id: string;
  uri: string;
  title: string;
  template: string;
  data: Record<string, unknown>;
  version: number;
  status: AppToolCallStatus;
  progress?: number;
  statusMessage?: string;
  toolName: string;
  serverName: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  history: AppLiveHistoryEntry[];
}

/** Tuỳ chọn khi tạo instance. */
export interface CreateAppLiveOptions {
  uri?: string;
  title?: string;
  toolName: string;
  serverName: string;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Tạo một live app instance từ template + dữ liệu. Template được
 * render thử ngay (placeholder thiếu chỉ cảnh báo, không fail) và
 * HTML kết quả phải qua `validateAppHtml` — template xấu bị chặn
 * trước khi instance tồn tại.
 */
export function createAppLiveInstance(
  template: string,
  data: Record<string, unknown>,
  options: CreateAppLiveOptions,
): AppLiveInstance {
  const now = options.now ?? Date.now;
  const nowMs = now();
  let dataBytes = 0;
  try {
    dataBytes = JSON.stringify(data).length;
  } catch {
    throw new AppLiveError('Dữ liệu của app không serialize được thành JSON.', 'bad-data');
  }
  if (dataBytes > APP_LIVE_MAX_DATA_BYTES) {
    throw new AppLiveError(
      `Dữ liệu của app ${dataBytes} byte, vượt giới hạn ${APP_LIVE_MAX_DATA_BYTES}.`,
      'data-too-large',
    );
  }
  const rendered = renderAppTemplate(template, data);
  const validation = validateAppHtml(rendered.html);
  if (!validation.valid) {
    throw new AppLiveError(
      `Template của app không hợp lệ: ${validation.errors.join('; ')}`,
      'invalid-template',
    );
  }
  const id = `live-${nowMs}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const ttlMs = options.ttlMs ?? APP_LIVE_DEFAULT_TTL_MS;
  return {
    id,
    uri: options.uri ?? `ui://live/${id}`,
    title: options.title ?? 'MCP App',
    template,
    data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    version: 1,
    status: 'idle',
    toolName: options.toolName,
    serverName: options.serverName,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(1000, ttlMs),
    history: [{ atMs: nowMs, version: 1, kind: 'created', status: 'idle' }],
  };
}

/** Render HTML hiện tại của instance (template + data mới nhất). */
export function renderAppLiveInstance(instance: AppLiveInstance): { html: string; missing: string[] } {
  const { html, missing } = renderAppTemplate(instance.template, instance.data);
  return { html, missing };
}

/**
 * Áp patch dữ liệu cho instance. `expectedVersion` (nếu có) phải
 * bằng version hiện tại — patch stale (version cũ hơn) bị từ chối
 * để tránh ghi đè dữ liệu mới bằng dữ liệu cũ.
 */
export function patchAppLiveInstance(
  instance: AppLiveInstance,
  patch: Record<string, unknown>,
  options: { expectedVersion?: number; now?: () => number } = {},
): AppLiveInstance {
  const now = options.now ?? Date.now;
  if (options.expectedVersion !== undefined && options.expectedVersion !== instance.version) {
    throw new AppLiveError(
      `Patch stale: version kỳ vọng ${options.expectedVersion} nhưng instance đang ở ${instance.version}.`,
      'stale-patch',
    );
  }
  const nextData = applyDataPatch(instance.data, patch);
  let dataBytes = 0;
  try {
    dataBytes = JSON.stringify(nextData).length;
  } catch {
    throw new AppLiveError('Dữ liệu sau patch không serialize được.', 'bad-data');
  }
  if (dataBytes > APP_LIVE_MAX_DATA_BYTES) {
    throw new AppLiveError('Dữ liệu sau patch vượt giới hạn kích thước.', 'data-too-large');
  }
  const nowMs = now();
  const next: AppLiveInstance = {
    ...instance,
    data: nextData,
    version: instance.version + 1,
    updatedAtMs: nowMs,
    history: [
      ...instance.history.slice(-(APP_LIVE_MAX_HISTORY - 1)),
      { atMs: nowMs, version: instance.version + 1, kind: 'data', status: instance.status },
    ],
  };
  return next;
}

/** Chuyển trạng thái tool call của instance (theo state machine). */
export function setAppLiveStatus(
  instance: AppLiveInstance,
  status: AppToolCallStatus,
  detail: { progress?: number; message?: string; now?: () => number } = {},
): AppLiveInstance {
  if (!canTransitionAppStatus(instance.status, status)) {
    throw new AppLiveError(
      `Không thể chuyển trạng thái app từ "${instance.status}" sang "${status}".`,
      'bad-status-transition',
    );
  }
  if (detail.progress !== undefined && (detail.progress < 0 || detail.progress > 100 || !Number.isFinite(detail.progress))) {
    throw new AppLiveError('progress phải nằm trong 0..100.', 'bad-progress');
  }
  const now = detail.now ?? Date.now;
  const nowMs = now();
  return {
    ...instance,
    status,
    ...(detail.progress !== undefined ? { progress: detail.progress } : {}),
    ...(detail.message !== undefined ? { statusMessage: detail.message } : {}),
    updatedAtMs: nowMs,
    history: [
      ...instance.history.slice(-(APP_LIVE_MAX_HISTORY - 1)),
      {
        atMs: nowMs,
        version: instance.version,
        kind: 'status',
        status,
        ...(detail.progress !== undefined ? { progress: detail.progress } : {}),
        ...(detail.message !== undefined ? { message: detail.message } : {}),
      },
    ],
  };
}

/** True khi instance đã hết hạn (quá TTL). */
export function isAppLiveExpired(instance: AppLiveInstance, nowMs = Date.now()): boolean {
  return nowMs >= instance.expiresAtMs;
}

/** Tóm tắt hiển thị của instance (không chứa template/data đầy đủ). */
export function describeAppLiveInstance(instance: AppLiveInstance): string {
  const progress = instance.progress !== undefined ? ` ${Math.round(instance.progress)}%` : '';
  return `${instance.title} [${instance.serverName}/${instance.toolName}] v${instance.version} ${instance.status}${progress}`;
}

/** Kết quả parse một tool result có live app. */
export type ParseLiveAppResult =
  | { app: AppLiveInstance; error?: undefined }
  | { app: null; error?: string };

/**
 * Parse tool result tìm live app: nhận 2 dạng —
 *   A. `structuredContent.uiTemplate = { template, data, title, uri }`
 *   B. resource `ui://` kèm `data` trong cùng result
 *      (`structuredContent.appData` hoặc `resource.data`).
 * Trả `{ app: null, error }` khi có khai báo nhưng sai (template rỗng,
 * data không phải object...); `{ app: null }` không error khi result
 * không chứa app nào (tool thường).
 */
export function parseLiveAppResult(
  result: unknown,
  context: { toolName: string; serverName: string; now?: () => number; ttlMs?: number },
): ParseLiveAppResult {
  if (!isRecord(result)) return { app: null };
  const structured = isRecord(result['structuredContent']) ? result['structuredContent'] : undefined;
  const templateField = structured?.['uiTemplate'];
  if (isRecord(templateField)) {
    const template = asNonEmptyString(templateField['template']);
    if (!template) return { app: null, error: 'uiTemplate thiếu template HTML.' };
    const data = templateField['data'];
    if (!isRecord(data)) return { app: null, error: 'uiTemplate.data phải là object JSON.' };
    try {
      const app = createAppLiveInstance(template, data, {
        uri: asNonEmptyString(templateField['uri']),
        title: asNonEmptyString(templateField['title']),
        toolName: context.toolName,
        serverName: context.serverName,
        ttlMs: context.ttlMs,
        now: context.now,
      });
      return { app };
    } catch (err) {
      return { app: null, error: (err as Error).message };
    }
  }
  // Dạng B: resource ui:// + data đi kèm.
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const appResource = content.find(
    (b): b is Record<string, unknown> =>
      isRecord(b) && (b['type'] === 'resource' || b['type'] === 'resource_link') && typeof b['uri'] === 'string' && (b['uri'] as string).startsWith('ui://'),
  );
  const dataField = structured?.['appData'] ?? structured?.['data'];
  if (appResource && isRecord(dataField)) {
    const text = typeof appResource['text'] === 'string' ? appResource['text'] : undefined;
    if (!text) return { app: null, error: 'Resource ui:// không có HTML text.' };
    try {
      const app = createAppLiveInstance(text, dataField, {
        uri: appResource['uri'] as string,
        title: asNonEmptyString(structured?.['title']),
        toolName: context.toolName,
        serverName: context.serverName,
        ttlMs: context.ttlMs,
        now: context.now,
      });
      return { app };
    } catch (err) {
      return { app: null, error: (err as Error).message };
    }
  }
  return { app: null };
}
