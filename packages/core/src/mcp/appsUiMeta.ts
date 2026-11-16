/**
 * MCP Apps host v13 — khai báo UI của tool qua `_meta.ui` (SEP-1865, ideas only).
 *
 * Một MCP tool muốn trả về UI tương tác thì khai báo trong `_meta` của
 * chính nó, để host biết TRƯỚC KHI gọi tool rằng kết quả sẽ có app:
 *
 * ```json
 * {
 *   "name": "show-dashboard",
 *   "description": "...",
 *   "inputSchema": { "...": "..." },
 *   "_meta": {
 *     "ui": {
 *       "resourceUri": "ui://my-server/dashboard",
 *       "displayMode": "inline",
 *       "preferredWidth": 720,
 *       "preferredHeight": 480,
 *       "capabilities": ["tools-call", "open-link"]
 *     }
 *   }
 * }
 * ```
 *
 * Và khi tool trả kết quả, app nằm trong resource có MIME
 * `text/html;profile=mcp-app` (SEP-1865) — host nhận cả dạng profile
 * này lẫn `text/html` thuần (tương thích ngược với các app v0.97–v1.12).
 * Resource URI luôn có dạng `ui://<server>/<path...>`; host KHÔNG
 * fetch URI này từ mạng — nó chỉ là khoá tra cứu trong registry
 * `ui://` (xem `appsUiRegistry.ts`), hoặc resource kèm ngay trong
 * kết quả `tools/call` (xem `parseAppResult` trong `apps.ts`).
 *
 * Module này thuần (không DOM, không network) nên test được bằng
 * node:test. Không copy code/text/tài sản của bất kỳ repo nào.
 */

import { MCP_APP_MAX_TITLE_CHARS, MCP_APP_MIME_TYPE } from './apps';

/** MIME type chuẩn của MCP App theo SEP-1865. */
export const MCP_APP_PROFILE_MIME_TYPE = 'text/html;profile=mcp-app';
/** Extension name của MCP Apps (khớp `MCP_APPS_EXTENSION` trong apps.ts). */
export const MCP_APPS_UI_META_KEY = 'ui';

/** Display mode mà tool gợi ý cho app của nó. */
export const UI_META_DISPLAY_MODES = ['inline', 'fullscreen', 'pip'] as const;
export type UiMetaDisplayMode = (typeof UI_META_DISPLAY_MODES)[number];

/** Capability mà app xin host (host vẫn là người quyết định cuối). */
export const UI_META_CAPABILITIES = [
  'tools-call',
  'open-link',
  'notify',
  'model-context',
  'form-submit',
  'live-data',
] as const;
export type UiMetaCapability = (typeof UI_META_CAPABILITIES)[number];

/** Chiều rộng/cao gợi ý tối đa cho app (px) — host clamp theo container. */
export const UI_META_MAX_PREFERRED_WIDTH = 3840;
export const UI_META_MAX_PREFERRED_HEIGHT = 2160;
/** Độ dài tối đa của một resourceUri `ui://...`. */
export const UI_RESOURCE_URI_MAX_CHARS = 512;

export class UiMetaError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UiMetaError';
    this.code = code;
  }
}

/** Kết quả parse một MIME type `text/html[;profile=mcp-app]`. */
export interface ParsedUiMimeType {
  /** Phần base, luôn `text/html` khi hợp lệ. */
  base: string;
  /** Giá trị tham số `profile` (nếu có). */
  profile?: string;
  /** True khi đây là MIME của MCP App (base text/html, profile rỗng hoặc mcp-app). */
  isMcpApp: boolean;
  /** MIME đã chuẩn hoá (base + profile, tham số thừa đã lược). */
  normalized: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Parse một MIME type có thể kèm tham số, vd
 * `text/html;profile=mcp-app` hay `Text/HTML ; charset=utf-8`.
 * Trả `isMcpApp=false` (không throw) khi base không phải text/html
 * hoặc profile khác `mcp-app` — caller quyết định chặn hay bỏ qua.
 */
export function parseUiMimeType(mimeType: unknown): ParsedUiMimeType {
  const raw = typeof mimeType === 'string' ? mimeType.trim() : '';
  const [basePart, ...paramParts] = raw.split(';');
  const base = (basePart ?? '').trim().toLowerCase();
  let profile: string | undefined;
  for (const part of paramParts) {
    const [key, ...rest] = part.split('=');
    if ((key ?? '').trim().toLowerCase() === 'profile') {
      profile = rest.join('=').trim().replace(/^"|"$/g, '').toLowerCase();
    }
  }
  const isMcpApp =
    base === MCP_APP_MIME_TYPE && (profile === undefined || profile === 'mcp-app');
  return {
    base,
    ...(profile !== undefined ? { profile } : {}),
    isMcpApp,
    normalized: profile !== undefined ? `${base};profile=${profile}` : base,
  };
}

/** True khi MIME type là của MCP App (`text/html` hoặc `text/html;profile=mcp-app`). */
export function isMcpAppMimeType(mimeType: unknown): boolean {
  return parseUiMimeType(mimeType).isMcpApp;
}

/** True khi MIME type là dạng profile đầy đủ `text/html;profile=mcp-app`. */
export function isProfiledMcpAppMimeType(mimeType: unknown): boolean {
  const parsed = parseUiMimeType(mimeType);
  return parsed.isMcpApp && parsed.profile === 'mcp-app';
}

/** Một resourceUri `ui://` đã parse. */
export interface ParsedUiResourceUri {
  /** URI gốc (đã trim). */
  uri: string;
  /** Tên MCP server sở hữu resource. */
  server: string;
  /** Đường dẫn sau server (vd `dashboard/main`). */
  path: string;
  /** Tên app = đoạn cuối của path. */
  name: string;
}

/**
 * Validate + parse một resourceUri `ui://<server>/<path...>`.
 * Ném `UiMetaError` khi sai scheme, thiếu server, thiếu path, có
 * ký tự cấm (khoảng trắng, `..`, query, fragment) hoặc quá dài.
 */
export function parseUiResourceUri(uri: unknown): ParsedUiResourceUri {
  const value = asNonEmptyString(uri);
  if (value === undefined) {
    throw new UiMetaError('App resourceUri rỗng hoặc không phải chuỗi.', 'ui-bad-uri');
  }
  if (value.length > UI_RESOURCE_URI_MAX_CHARS) {
    throw new UiMetaError(
      `App resourceUri quá dài (${value.length} ký tự, tối đa ${UI_RESOURCE_URI_MAX_CHARS}).`,
      'ui-uri-too-long',
    );
  }
  if (!value.startsWith('ui://')) {
    throw new UiMetaError('App resourceUri phải bắt đầu bằng "ui://".', 'ui-bad-uri');
  }
  const rest = value.slice('ui://'.length);
  if (rest === '' || rest.startsWith('/')) {
    throw new UiMetaError('App resourceUri thiếu tên server.', 'ui-bad-uri');
  }
  if (/\s/.test(value) || value.includes('..') || value.includes('?') || value.includes('#')) {
    throw new UiMetaError(
      'App resourceUri chứa ký tự cấm (khoảng trắng, "..", query hoặc fragment).',
      'ui-bad-uri',
    );
  }
  const [server, ...pathParts] = rest.split('/');
  if (!server || pathParts.length === 0 || pathParts.some((p) => p === '')) {
    throw new UiMetaError(
      'App resourceUri phải có dạng "ui://<server>/<ten-app>" (path không rỗng).',
      'ui-bad-uri',
    );
  }
  const path = pathParts.join('/');
  return { uri: value, server, path, name: pathParts[pathParts.length - 1] };
}

/** True khi giá trị là resourceUri `ui://` hợp lệ (không throw). */
export function isValidUiResourceUri(uri: unknown): boolean {
  try {
    parseUiResourceUri(uri);
    return true;
  } catch {
    return false;
  }
}

/** Build một resourceUri `ui://` từ server + path (validate lại trước khi trả). */
export function buildUiResourceUri(server: string, path: string): string {
  const uri = `ui://${server.trim()}/${path
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('/')}`;
  return parseUiResourceUri(uri).uri;
}

/** Khai báo UI của một tool (nội dung `_meta.ui`). */
export interface ToolUiDeclaration {
  /** Resource `ui://` chứa HTML của app. */
  resourceUri: string;
  /** Server sở hữu resource (suy ra từ resourceUri). */
  server: string;
  /** Tên app (đoạn cuối của resourceUri). */
  appName: string;
  /** Display mode tool gợi ý (host có thể đổi theo policy). */
  displayMode?: UiMetaDisplayMode;
  /** Chiều rộng gợi ý (px). */
  preferredWidth?: number;
  /** Chiều cao gợi ý (px). */
  preferredHeight?: number;
  /** Capability app xin host. */
  capabilities?: UiMetaCapability[];
  /** Tiêu đề gợi ý (nếu server đặt trong `_meta.ui.title`). */
  title?: string;
}

function parsePreferredSize(value: unknown, field: 'preferredWidth' | 'preferredHeight'): number | undefined {
  if (value === undefined) return undefined;
  const max = field === 'preferredWidth' ? UI_META_MAX_PREFERRED_WIDTH : UI_META_MAX_PREFERRED_HEIGHT;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UiMetaError(
      `_meta.ui.${field} phải là số dương (tối đa ${max}).`,
      'ui-bad-size',
    );
  }
  return Math.min(Math.floor(value), max);
}

/**
 * Parse khối `_meta.ui` thô thành `ToolUiDeclaration`.
 * Trả null khi tool không khai báo `_meta.ui` (tool thường, không có app).
 * Ném `UiMetaError` khi `_meta.ui` có mặt nhưng sai định dạng — lỗi
 * khai báo phải lộ ra để server sửa, không được lặng lẽ bỏ qua.
 */
export function parseToolUiMetaBlock(uiMeta: unknown): ToolUiDeclaration | null {
  if (uiMeta === undefined || uiMeta === null) return null;
  if (!isRecord(uiMeta)) {
    throw new UiMetaError('_meta.ui phải là object.', 'ui-bad-meta');
  }
  const resourceUri = parseUiResourceUri(uiMeta['resourceUri']);
  const displayModeRaw = uiMeta['displayMode'];
  let displayMode: UiMetaDisplayMode | undefined;
  if (displayModeRaw !== undefined) {
    if (
      typeof displayModeRaw !== 'string' ||
      !(UI_META_DISPLAY_MODES as readonly string[]).includes(displayModeRaw)
    ) {
      throw new UiMetaError(
        `_meta.ui.displayMode phải là một trong: ${UI_META_DISPLAY_MODES.join(', ')}.`,
        'ui-bad-display-mode',
      );
    }
    displayMode = displayModeRaw as UiMetaDisplayMode;
  }
  let capabilities: UiMetaCapability[] | undefined;
  const capsRaw = uiMeta['capabilities'];
  if (capsRaw !== undefined) {
    if (!Array.isArray(capsRaw) || capsRaw.some((c) => typeof c !== 'string')) {
      throw new UiMetaError('_meta.ui.capabilities phải là mảng chuỗi.', 'ui-bad-capability');
    }
    const unknownCap = (capsRaw as string[]).find(
      (c) => !(UI_META_CAPABILITIES as readonly string[]).includes(c),
    );
    if (unknownCap !== undefined) {
      throw new UiMetaError(
        `Capability không rõ trong _meta.ui: "${unknownCap}" (cho phép: ${UI_META_CAPABILITIES.join(', ')}).`,
        'ui-bad-capability',
      );
    }
    capabilities = [...new Set(capsRaw as UiMetaCapability[])];
  }
  const title = asNonEmptyString(uiMeta['title']);
  if (title !== undefined && title.length > MCP_APP_MAX_TITLE_CHARS) {
    throw new UiMetaError(
      `_meta.ui.title quá dài (tối đa ${MCP_APP_MAX_TITLE_CHARS} ký tự).`,
      'ui-title-too-long',
    );
  }
  return {
    resourceUri: resourceUri.uri,
    server: resourceUri.server,
    appName: resourceUri.name,
    ...(displayMode ? { displayMode } : {}),
    ...(parsePreferredSize(uiMeta['preferredWidth'], 'preferredWidth') !== undefined
      ? { preferredWidth: parsePreferredSize(uiMeta['preferredWidth'], 'preferredWidth') }
      : {}),
    ...(parsePreferredSize(uiMeta['preferredHeight'], 'preferredHeight') !== undefined
      ? { preferredHeight: parsePreferredSize(uiMeta['preferredHeight'], 'preferredHeight') }
      : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * Đọc khai báo UI từ một tool definition MCP (shape tối thiểu:
 * `{ name, _meta?: { ui?: ... } }`). Trả null khi tool không khai
 * báo app. Ném `UiMetaError` khi khai báo sai.
 */
export function parseToolUiMeta(tool: unknown): ToolUiDeclaration | null {
  if (!isRecord(tool)) return null;
  const meta = tool['_meta'];
  if (meta === undefined || meta === null) return null;
  if (!isRecord(meta)) {
    throw new UiMetaError('_meta của tool phải là object.', 'ui-bad-meta');
  }
  return parseToolUiMetaBlock(meta['ui']);
}

/** True khi tool khai báo app qua `_meta.ui` (không throw với meta sai — chỉ kiểm tra có/không). */
export function toolDeclaresUi(tool: unknown): boolean {
  try {
    return parseToolUiMeta(tool) !== null;
  } catch {
    return isRecord(tool) && isRecord(tool['_meta']) && tool['_meta']['ui'] !== undefined;
  }
}

/** Lọc ra các tool có khai báo UI từ một danh sách tool của server. */
export function listUiTools(tools: readonly unknown[]): { name: string; ui: ToolUiDeclaration }[] {
  const out: { name: string; ui: ToolUiDeclaration }[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = asNonEmptyString(tool['name']);
    if (!name) continue;
    const ui = parseToolUiMeta(tool);
    if (ui) out.push({ name, ui });
  }
  return out;
}

/**
 * Gắn khai báo UI vào một kết quả `tools/call`: tìm resource app
 * trong content của result khớp với `resourceUri` đã khai báo
 * (dạng A của `parseAppResult`: block resource có `uri` trùng +
 * MIME là app). Trả `{ found, uri?, mimeType? }` — không throw,
 * để host quyết định fallback (registry → structuredContent).
 */
export function matchDeclaredResourceInResult(
  declaration: ToolUiDeclaration,
  result: unknown,
): { found: boolean; uri?: string; mimeType?: string } {
  if (!isRecord(result) || !Array.isArray(result['content'])) return { found: false };
  for (const block of result['content'] as unknown[]) {
    if (!isRecord(block)) continue;
    const resource = isRecord(block['resource']) ? block['resource'] : undefined;
    const uri = asNonEmptyString(block['uri']) ?? asNonEmptyString(resource?.['uri']);
    if (uri !== declaration.resourceUri) continue;
    const mime = asNonEmptyString(block['mimeType']) ?? asNonEmptyString(resource?.['mimeType']);
    if (mime !== undefined && !isMcpAppMimeType(mime)) continue;
    return { found: true, uri, ...(mime ? { mimeType: mime } : {}) };
  }
  return { found: false };
}

/**
 * Tóm tắt khai báo UI để log / hiển thị trong UI (không lộ HTML).
 */
export function describeToolUi(declaration: ToolUiDeclaration): string {
  const parts = [declaration.resourceUri];
  if (declaration.displayMode) parts.push(`mode=${declaration.displayMode}`);
  if (declaration.preferredWidth || declaration.preferredHeight) {
    parts.push(`size=${declaration.preferredWidth ?? '?'}x${declaration.preferredHeight ?? '?'}`);
  }
  if (declaration.capabilities?.length) parts.push(`caps=${declaration.capabilities.join('+')}`);
  return parts.join(' ');
}
