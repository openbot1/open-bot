/**
 * MCP Apps host v15 — registry `ui://` + khai báo `_meta.ui` +
 * app manifest + host context (SEP-1865 stable 2026-01-26,
 * ideas only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * V15 xây trên nền v14 và siết thêm 3 cửa mà v14 còn để mở:
 *
 *   1. MIME bắt buộc `text/html;profile=mcp-app` ở CẢ hai cửa:
 *      lúc đăng ký resource VÀ lúc khai báo `_meta.ui` (v14 chỉ
 *      kiểm tra ở tầng tools). Resource đăng ký với MIME khác bị
 *      từ chối ngay — không có app nào lọt vào registry với MIME
 *      lạ rồi mới bị chặn lúc mở.
 *   2. App manifest: mỗi app phải có manifest (tên, version,
 *      capabilities xin host, sandbox profile, CSP profile) trước
 *      khi host mở nó. Manifest sai (capability lạ, version không
 *      phải semver, sandbox profile không rõ) → từ chối đăng ký.
 *   3. Host context có cấu trúc: `ui/initialize` trả host context
 *      đầy đủ (theme, locale, timezone, platform, display mode,
 *      kích thước container, capabilities host hỗ trợ) — app không
 *      phải đoán môi trường, và host không rò rỉ thông tin nhạy
 *      cảm (không có đường dẫn local, không có token).
 *
 * Module này thuần (không DOM, không network). Registry v15 bọc
 * `McpAppsUiRegistryV14` để tái dùng validate HTML / LRU / TTL /
 * fallback bắt buộc / negotiation, và thêm lớp MIME + manifest +
 * host context của riêng v15.
 */

import {
  McpAppsUiRegistryV14,
  MCP_APPS_V14_VERSION,
  negotiateAppsCapability,
  parseV14ClientCapability,
  type ToolUiRegistrationV14,
  type V14ClientAppsCapability,
  type V14NegotiationResult,
} from './appsUiV14';
import {
  isProfiledMcpAppMimeType,
  MCP_APP_PROFILE_MIME_TYPE,
  parseUiMimeType,
  parseUiResourceUri,
  type ToolUiDeclaration,
} from './appsUiMeta';
import type { UiResourceEntry, UiResourceSnapshot } from './appsUiRegistry';

/** Version của host v15 (ghi vào host context + audit). */
export const MCP_APPS_V15_VERSION = '15.0.0';
/** Protocol version của dialect `ui/` mà v15 nói (khớp v14). */
export const MCP_APPS_V15_PROTOCOL_VERSION = 'ui/1.0';
/** MIME duy nhất được chấp nhận cho app v15. */
export const MCP_APPS_V15_MIME_TYPE = MCP_APP_PROFILE_MIME_TYPE;
/** Version v14 mà v15 bọc (ghi vào audit để trace). */
export const MCP_APPS_V15_BASE_VERSION = MCP_APPS_V14_VERSION;

/** Số tool khai báo UI tối đa trong registry v15 (mặc định). */
export const UI_V15_MAX_TOOLS = 500;
/** Tiêu đề app tối đa (ký tự) — khớp v14. */
export const UI_V15_MAX_TITLE_CHARS = 120;
/** Manifest JSON tối đa (bytes) — chống manifest phình. */
export const UI_V15_MAX_MANIFEST_BYTES = 64 * 1024;
/** App version phải là semver `MAJOR.MINOR.PATCH` (cho phép hậu tố). */
export const UI_V15_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Sandbox profile mà app xin host (quyết định iframe sandbox + CSP). */
export const UI_V15_SANDBOX_PROFILES = ['display-only', 'interactive', 'privileged'] as const;
export type UiV15SandboxProfile = (typeof UI_V15_SANDBOX_PROFILES)[number];

/** CSP profile mà app xin host (quyết định connect-src / media). */
export const UI_V15_CSP_PROFILES = ['strict', 'media', 'network'] as const;
export type UiV15CspProfile = (typeof UI_V15_CSP_PROFILES)[number];

/** Capability app có thể xin host (khớp UI_META_CAPABILITIES mở rộng). */
export const UI_V15_APP_CAPABILITIES = [
  'tools-call',
  'resources-read',
  'open-link',
  'post-message',
  'model-context',
  'display-mode',
  'clipboard-write',
  'media-microphone',
  'media-camera',
] as const;
export type UiV15AppCapability = (typeof UI_V15_APP_CAPABILITIES)[number];

/** Capability host hỗ trợ (trả trong host context của `ui/initialize`). */
export const UI_V15_HOST_CAPABILITIES = [
  'tools-call',
  'resources-read',
  'open-link',
  'post-message',
  'model-context',
  'display-mode',
  'visualiser',
  'consent',
] as const;
export type UiV15HostCapability = (typeof UI_V15_HOST_CAPABILITIES)[number];

export class McpAppsV15Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsV15Error';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// App manifest
// ---------------------------------------------------------------------------

/** Manifest của một MCP App v15 — khai báo trước khi host mở app. */
export interface AppManifestV15 {
  /** Tên app (kebab-case, khớp đoạn cuối resourceUri). */
  name: string;
  /** Version semver của app. */
  version: string;
  /** Mô tả ngắn cho panel/gallery (tối đa 500 ký tự). */
  description?: string;
  /** Server sở hữu app. */
  server: string;
  /** Resource `ui://` chứa HTML của app. */
  resourceUri: string;
  /** Capability app xin host (rỗng = chỉ hiển thị). */
  capabilities: UiV15AppCapability[];
  /** Sandbox profile (mặc định display-only). */
  sandboxProfile: UiV15SandboxProfile;
  /** CSP profile (mặc định strict). */
  cspProfile: UiV15CspProfile;
  /** Tool tạo ra app này (để bridge giới hạn tools/call). */
  toolName?: string;
  /** Display mode gợi ý. */
  displayMode?: ToolUiDeclaration['displayMode'];
  /** Tác giả app (hiển thị trong gallery, không dùng để quyết định). */
  author?: string;
}

/** Kết quả validate manifest (kèm cảnh báo không chặn). */
export interface ValidateManifestResult {
  manifest: AppManifestV15;
  warnings: string[];
}

/**
 * Validate + chuẩn hoá một app manifest thô. Ném `McpAppsV15Error`
 * khi: tên rỗng/sai định dạng, version không phải semver, resourceUri
 * không phải `ui://`, capability lạ, sandbox/CSP profile không rõ,
 * hoặc manifest quá lớn. Trả cảnh báo (không chặn) khi app xin
 * capability nhạy cảm (media) hoặc CSP network.
 */
export function validateAppManifestV15(input: unknown): ValidateManifestResult {
  if (!isRecord(input)) {
    throw new McpAppsV15Error('App manifest v15 phải là object.', 'ui-v15-bad-manifest');
  }
  if (byteLength(JSON.stringify(input)) > UI_V15_MAX_MANIFEST_BYTES) {
    throw new McpAppsV15Error(
      `App manifest v15 quá lớn (tối đa ${UI_V15_MAX_MANIFEST_BYTES} bytes).`,
      'ui-v15-manifest-too-large',
    );
  }
  const name = asNonEmptyString(input['name']);
  if (!name || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) || name.includes('--')) {
    throw new McpAppsV15Error(
      `Tên app "${String(input['name'] ?? '')}" không hợp lệ: phải là kebab-case (chữ thường, số, dấu gạch ngang, không bắt đầu/kết thúc bằng dấu gạch).`,
      'ui-v15-bad-app-name',
    );
  }
  const versionRaw = asNonEmptyString(input['version']);
  if (!versionRaw || !UI_V15_SEMVER_RE.test(versionRaw)) {
    throw new McpAppsV15Error(
      `Version app "${String(input['version'] ?? '')}" không hợp lệ: phải là semver MAJOR.MINOR.PATCH (vd "1.2.0").`,
      'ui-v15-bad-version',
    );
  }
  const server = asNonEmptyString(input['server']);
  if (!server) {
    throw new McpAppsV15Error('App manifest thiếu server.', 'ui-v15-bad-server');
  }
  const parsedUri = parseUiResourceUri(input['resourceUri']);
  if (parsedUri.server !== server) {
    throw new McpAppsV15Error(
      `Manifest khai báo server "${server}" nhưng resourceUri ${parsedUri.uri} thuộc server "${parsedUri.server}".`,
      'ui-v15-server-mismatch',
    );
  }
  const tail = parsedUri.uri.split('/').filter(Boolean).pop() ?? '';
  if (tail !== name) {
    throw new McpAppsV15Error(
      `Tên app "${name}" không khớp đoạn cuối resourceUri "${parsedUri.uri}" (phải là "${tail}").`,
      'ui-v15-name-uri-mismatch',
    );
  }
  const description = asNonEmptyString(input['description']);
  if (description !== undefined && description.length > 500) {
    throw new McpAppsV15Error(
      'Mô tả app tối đa 500 ký tự.',
      'ui-v15-description-too-long',
    );
  }
  const capsRaw = input['capabilities'];
  let capabilities: UiV15AppCapability[] = [];
  if (capsRaw !== undefined) {
    if (!Array.isArray(capsRaw) || capsRaw.some((c) => typeof c !== 'string')) {
      throw new McpAppsV15Error(
        'App manifest capabilities phải là mảng chuỗi.',
        'ui-v15-bad-capabilities',
      );
    }
    const unknownCap = (capsRaw as string[]).find(
      (c) => !(UI_V15_APP_CAPABILITIES as readonly string[]).includes(c),
    );
    if (unknownCap !== undefined) {
      throw new McpAppsV15Error(
        `Capability không rõ trong manifest: "${unknownCap}".`,
        'ui-v15-unknown-capability',
      );
    }
    capabilities = [...new Set(capsRaw as UiV15AppCapability[])];
  }
  const sandboxRaw = input['sandboxProfile'] ?? 'display-only';
  if (
    typeof sandboxRaw !== 'string' ||
    !(UI_V15_SANDBOX_PROFILES as readonly string[]).includes(sandboxRaw)
  ) {
    throw new McpAppsV15Error(
      `Sandbox profile không rõ: "${String(sandboxRaw)}" (phải là một trong: ${UI_V15_SANDBOX_PROFILES.join(', ')}).`,
      'ui-v15-bad-sandbox-profile',
    );
  }
  const cspRaw = input['cspProfile'] ?? 'strict';
  if (
    typeof cspRaw !== 'string' ||
    !(UI_V15_CSP_PROFILES as readonly string[]).includes(cspRaw)
  ) {
    throw new McpAppsV15Error(
      `CSP profile không rõ: "${String(cspRaw)}" (phải là một trong: ${UI_V15_CSP_PROFILES.join(', ')}).`,
      'ui-v15-bad-csp-profile',
    );
  }
  const sandboxProfile = sandboxRaw as UiV15SandboxProfile;
  const cspProfile = cspRaw as UiV15CspProfile;
  // Quy tắc chéo: media/network chỉ đi với profile tương ứng.
  if (
    (capabilities.includes('media-microphone') || capabilities.includes('media-camera')) &&
    cspProfile === 'strict'
  ) {
    throw new McpAppsV15Error(
      'App xin quyền media (microphone/camera) nhưng CSP profile là "strict" — phải dùng CSP profile "media" trở lên.',
      'ui-v15-media-needs-csp',
    );
  }
  if (capabilities.includes('open-link') && sandboxProfile === 'display-only') {
    throw new McpAppsV15Error(
      'App xin capability "open-link" nhưng sandbox profile là "display-only" — phải dùng "interactive" trở lên.',
      'ui-v15-open-link-needs-interactive',
    );
  }
  if (sandboxProfile === 'privileged' && !capabilities.includes('tools-call')) {
    throw new McpAppsV15Error(
      'Sandbox profile "privileged" chỉ dùng cho app gọi tool — app không xin "tools-call" thì không được dùng profile này.',
      'ui-v15-privileged-needs-tools-call',
    );
  }
  const toolName = asNonEmptyString(input['toolName']);
  const author = asNonEmptyString(input['author']);
  const displayModeRaw = input['displayMode'];
  let displayMode: ToolUiDeclaration['displayMode'];
  if (displayModeRaw !== undefined) {
    if (
      typeof displayModeRaw !== 'string' ||
      !(['inline', 'fullscreen', 'pip'] as readonly string[]).includes(displayModeRaw)
    ) {
      throw new McpAppsV15Error(
        `Display mode không rõ trong manifest: "${String(displayModeRaw)}".`,
        'ui-v15-bad-display-mode',
      );
    }
    displayMode = displayModeRaw as ToolUiDeclaration['displayMode'];
  }
  const warnings: string[] = [];
  if (capabilities.includes('media-microphone') || capabilities.includes('media-camera')) {
    warnings.push('App xin quyền media — user sẽ được hỏi trước khi cấp.');
  }
  if (cspProfile === 'network') {
    warnings.push('CSP profile "network" cho phép app kết nối host đã khai báo — kiểm tra allow-list trước khi mở.');
  }
  if (sandboxProfile === 'privileged') {
    warnings.push('Sandbox profile "privileged" — mọi tools/call của app đều qua consent.');
  }
  if (capabilities.includes('clipboard-write')) {
    warnings.push('App xin ghi clipboard — chỉ ghi khi user tương tác trực tiếp.');
  }
  const manifest: AppManifestV15 = {
    name,
    version: versionRaw,
    ...(description ? { description } : {}),
    server,
    resourceUri: parsedUri.uri,
    capabilities,
    sandboxProfile,
    cspProfile,
    ...(toolName ? { toolName } : {}),
    ...(displayMode ? { displayMode } : {}),
    ...(author ? { author } : {}),
  };
  return { manifest, warnings };
}

/**
 * Validate MIME của một resource app: chỉ chấp nhận đúng
 * `text/html;profile=mcp-app` (không chấp nhận `text/html` trần,
 * không chấp nhận profile khác). Trả parsed MIME để caller dùng tiếp.
 */
export function validateAppMimeTypeV15(mimeType: unknown): { mimeType: string; profile: string } {
  if (!isProfiledMcpAppMimeType(mimeType)) {
    throw new McpAppsV15Error(
      `MIME của app v15 phải là "${MCP_APP_PROFILE_MIME_TYPE}" — nhận được "${String(mimeType ?? '')}".`,
      'ui-v15-bad-mime',
    );
  }
  const parsed = parseUiMimeType(mimeType);
  return { mimeType: parsed.normalized, profile: parsed.profile ?? 'mcp-app' };
}

/**
 * Kiểm tra HTML document đầy đủ (khớp cửa của v14) + cấm các mẫu
 * nguy hiểm mà registry v13/v14 chưa chặn ở tầng này: `<base href>`
 * trỏ ra ngoài, `import`/`fetch` tới `http:` trong inline script,
 * và form POST ra ngoài. Đây là lưới lọc sớm — quét thoát sandbox
 * đầy đủ vẫn chạy ở tầng frame build (appsPreviewV14).
 */
export function validateAppHtmlV15(uri: string, html: string): { ok: true; warnings: string[] } {
  const warnings: string[] = [];
  if (!/<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html)) {
    throw new McpAppsV15Error(
      `App ${uri} bị từ chối: app v15 phải là HTML document đầy đủ (<!doctype html><html>…) — không nhận đoạn HTML lẻ hay website nhúng ngoài.`,
      'ui-v15-invalid-html-document',
    );
  }
  if (/<base\s[^>]*href\s*=\s*["']https?:/i.test(html)) {
    throw new McpAppsV15Error(
      `App ${uri} bị từ chối: <base href> trỏ ra ngoài bị cấm — app phải tự chứa (self-contained).`,
      'ui-v15-base-href-blocked',
    );
  }
  if (/<form\s[^>]*action\s*=\s*["']https?:/i.test(html)) {
    throw new McpAppsV15Error(
      `App ${uri} bị từ chối: <form action> trỏ ra ngoài bị cấm — form phải gửi qua bridge tools/call.`,
      'ui-v15-form-action-blocked',
    );
  }
  if (/<script[^>]*\ssrc\s*=\s*["']https?:/i.test(html)) {
    warnings.push('App có <script src> ngoài — host sẽ chặn lúc build frame nếu host ngoài chưa được allow-list.');
  }
  if (/\b(fetch|XMLHttpRequest)\s*\(/i.test(html)) {
    warnings.push('App dùng fetch/XHR — chỉ được gọi host đã khai báo trong CSP profile network.');
  }
  if (/<iframe/i.test(html)) {
    warnings.push('App nhúng <iframe> — iframe lồng nhau bị sandbox chặn mặc định.');
  }
  return { ok: true as const, warnings };
}

// ---------------------------------------------------------------------------
// Host context
// ---------------------------------------------------------------------------

/** Host context host trả cho app trong `ui/initialize` (v15). */
export interface UiHostContextV15 {
  /** Protocol version dialect `ui/`. */
  protocolVersion: string;
  /** Version host v15. */
  hostVersion: string;
  /** Theme renderer đang dùng. */
  theme: 'light' | 'dark' | 'system';
  /** Locale UI (BCP 47, vd "vi", "en"). */
  locale: string;
  /** Timezone IANA của user (vd "Asia/Ho_Chi_Minh"). */
  timezone: string;
  /** Platform host (darwin / win32 / linux). */
  platform: string;
  /** Display mode host đang mở app. */
  displayMode: 'inline' | 'fullscreen' | 'pip';
  /** Kích thước container (px). */
  containerWidthPx: number;
  containerHeightPx: number;
  /** Capability host hỗ trợ. */
  capabilities: UiV15HostCapability[];
  /** Session id bridge của app này. */
  sessionId: string;
  /** App có auto-visualiser built-in không. */
  visualiserAvailable: boolean;
  /** Consent có bắt buộc cho action do UI khởi xướng không (luôn true). */
  consentRequired: boolean;
}

export interface BuildHostContextV15Input {
  sessionId: string;
  theme?: 'light' | 'dark' | 'system';
  locale?: string;
  timezone?: string;
  platform?: string;
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  containerWidthPx?: number;
  containerHeightPx?: number;
}

/**
 * Build host context cho `ui/initialize`. Không bao giờ rò rỉ
 * đường dẫn local, token, hay thông tin máy — chỉ những gì app
 * cần để render đúng (theme/locale/timezone/kích thước).
 */
export function buildHostContextV15(input: BuildHostContextV15Input): UiHostContextV15 {
  const sessionId = asNonEmptyString(input.sessionId);
  if (!sessionId) {
    throw new McpAppsV15Error('sessionId rỗng khi build host context v15.', 'ui-v15-bad-session');
  }
  const locale = asNonEmptyString(input.locale) ?? 'en';
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(locale)) {
    throw new McpAppsV15Error(
      `Locale không hợp lệ trong host context: "${locale}".`,
      'ui-v15-bad-locale',
    );
  }
  const timezone = asNonEmptyString(input.timezone) ?? 'UTC';
  const width = input.containerWidthPx ?? 0;
  const height = input.containerHeightPx ?? 0;
  if (width < 0 || height < 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new McpAppsV15Error(
      'Kích thước container trong host context phải là số không âm.',
      'ui-v15-bad-container-size',
    );
  }
  return {
    protocolVersion: MCP_APPS_V15_PROTOCOL_VERSION,
    hostVersion: MCP_APPS_V15_VERSION,
    theme: input.theme ?? 'system',
    locale,
    timezone,
    platform: asNonEmptyString(input.platform) ?? 'unknown',
    displayMode: input.displayMode ?? 'inline',
    containerWidthPx: Math.floor(width),
    containerHeightPx: Math.floor(height),
    capabilities: [...UI_V15_HOST_CAPABILITIES],
    sessionId,
    visualiserAvailable: true,
    consentRequired: true,
  };
}

// ---------------------------------------------------------------------------
// Registry v15
// ---------------------------------------------------------------------------

/** Một tool đã khai báo UI trong registry v15 (kèm manifest). */
export interface ToolUiRegistrationV15 extends ToolUiRegistrationV14 {
  /** Manifest v15 của app (undefined khi app đăng ký kiểu v14 cũ). */
  manifest?: AppManifestV15;
  /** Cảnh báo lúc validate manifest/HTML. */
  warnings: string[];
}

/** Snapshot nhẹ của một tool có UI v15. */
export interface ToolUiSnapshotV15 {
  toolName: string;
  serverName: string;
  resourceUri: string;
  appName: string;
  displayMode?: ToolUiDeclaration['displayMode'];
  resourceRegistered: boolean;
  hasTextFallback: boolean;
  fallbackChars: number;
  /** App có manifest v15 không (false = app v14 cũ, vẫn chạy). */
  hasManifest: boolean;
  manifestVersion?: string;
  sandboxProfile?: UiV15SandboxProfile;
  cspProfile?: UiV15CspProfile;
  capabilities: UiV15AppCapability[];
  version: number;
  updatedAtMs: number;
}

export interface McpAppsUiRegistryV15Options {
  now?: () => number;
  /** Registry v14 dùng chung (mặc định: tạo mới). */
  innerRegistry?: McpAppsUiRegistryV14;
  /** Giới hạn số tool khai báo UI (mặc định 500). */
  maxTools?: number;
}

/** Thống kê registry v15. */
export interface UiRegistryV15Stats {
  resources: number;
  totalBytes: number;
  uiTools: number;
  uiToolsWithFallback: number;
  uiToolsWithManifest: number;
  rejectedDeclarations: number;
  rejectedManifests: number;
  v14LegacyApps: number;
}

/**
 * Registry v15 — bọc registry v14 và thêm:
 *   - cửa MIME `text/html;profile=mcp-app` ở lúc đăng ký resource,
 *   - bảng manifest v15 theo resourceUri,
 *   - host context có cấu trúc cho `ui/initialize`,
 *   - snapshot v15 kèm trạng thái manifest.
 *
 * Luồng đăng ký đúng thứ tự:
 *   1. `registerResource(...)` — HTML + MIME profile + validate HTML.
 *   2. `registerManifest(...)` — manifest v15 (không bắt buộc với
 *      app v14 cũ, nhưng bắt buộc để mở app ở sandbox `privileged`
 *      hoặc xin media/network).
 *   3. `declareToolUi(toolName, uiMeta, textFallback)` — khai báo
 *      tool + fallback bắt buộc (uỷ quyền v14).
 */
export class McpAppsUiRegistryV15 {
  /** Registry v14 bên dưới (HTML + LRU + TTL + fallback + negotiation). */
  readonly inner: McpAppsUiRegistryV14;
  private readonly now: () => number;
  private readonly maxTools: number;
  private readonly manifests = new Map<string, AppManifestV15>();
  private readonly manifestWarnings = new Map<string, string[]>();
  private rejectedManifests = 0;

  constructor(options: McpAppsUiRegistryV15Options = {}) {
    this.now = options.now ?? Date.now;
    this.inner = options.innerRegistry ?? new McpAppsUiRegistryV14({ now: this.now });
    this.maxTools = Math.max(1, options.maxTools ?? UI_V15_MAX_TOOLS);
  }

  /** Số tool đã khai báo UI. */
  get size(): number {
    return this.inner.size;
  }

  // -- resource ui:// (uỷ quyền v14 + cửa MIME v15) ------------------------

  registerResource(input: {
    uri: string;
    serverName?: string;
    toolName?: string;
    title?: string;
    html: string;
    mimeType?: string;
    displayMode?: ToolUiDeclaration['displayMode'];
    ttlMs?: number;
  }): UiResourceEntry {
    // Cửa MIME v15: chỉ nhận đúng text/html;profile=mcp-app.
    const mime = input.mimeType ?? MCP_APP_PROFILE_MIME_TYPE;
    validateAppMimeTypeV15(mime);
    // Cửa HTML v15: document đầy đủ + cấm base/form ra ngoài.
    validateAppHtmlV15(input.uri, input.html);
    return this.inner.registerResource({ ...input, mimeType: MCP_APP_PROFILE_MIME_TYPE });
  }

  resolveResource(uri: string): UiResourceEntry | undefined {
    return this.inner.resolveResource(uri);
  }

  hasResource(uri: string): boolean {
    return this.inner.hasResource(uri);
  }

  unregisterResource(uri: string): boolean {
    this.manifests.delete(uri);
    this.manifestWarnings.delete(uri);
    return this.inner.unregisterResource(uri);
  }

  listResources(filter: { serverName?: string; toolName?: string } = {}): UiResourceSnapshot[] {
    return this.inner.listResources(filter);
  }

  // -- manifest ---------------------------------------------------------------

  /**
   * Đăng ký manifest v15 cho một resource đã đăng ký. Resource phải
   * tồn tại trước — manifest treo (trỏ resource chưa đăng ký) bị từ
   * chối như khai báo treo của v14. Đăng ký lại cùng URI thì cập
   * nhật (ghi đè manifest cũ).
   */
  registerManifest(input: unknown): ValidateManifestResult {
    let validated: ValidateManifestResult;
    try {
      validated = validateAppManifestV15(input);
    } catch (err) {
      this.rejectedManifests += 1;
      throw err;
    }
    const { manifest, warnings } = validated;
    if (!this.inner.hasResource(manifest.resourceUri)) {
      this.rejectedManifests += 1;
      throw new McpAppsV15Error(
        `Manifest của app ${manifest.resourceUri} bị từ chối: resource chưa đăng ký trong registry ui:// — đăng ký resource trước rồi mới đăng ký manifest.`,
        'ui-v15-unregistered-resource',
      );
    }
    this.manifests.set(manifest.resourceUri, manifest);
    this.manifestWarnings.set(manifest.resourceUri, warnings);
    return validated;
  }

  getManifest(resourceUri: string): AppManifestV15 | undefined {
    return this.manifests.get(resourceUri);
  }

  hasManifest(resourceUri: string): boolean {
    return this.manifests.has(resourceUri);
  }

  getManifestWarnings(resourceUri: string): string[] {
    return this.manifestWarnings.get(resourceUri) ?? [];
  }

  unregisterManifest(resourceUri: string): boolean {
    this.manifestWarnings.delete(resourceUri);
    return this.manifests.delete(resourceUri);
  }

  listManifests(filter: { serverName?: string } = {}): AppManifestV15[] {
    return [...this.manifests.values()]
      .filter((m) => filter.serverName === undefined || m.server === filter.serverName)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // -- khai báo _meta.ui (uỷ quyền v14, kèm manifest) ------------------------

  declareToolUi(
    toolName: string,
    uiMeta: unknown,
    options: { textFallback?: string; serverName?: string } = {},
  ): ToolUiRegistrationV15 {
    const base = this.inner.declareToolUi(toolName, uiMeta, options);
    const manifest = this.manifests.get(base.declaration.resourceUri);
    const warnings = this.manifestWarnings.get(base.declaration.resourceUri) ?? [];
    return { ...base, ...(manifest ? { manifest } : {}), warnings };
  }

  getToolUi(toolName: string): ToolUiRegistrationV15 | undefined {
    const base = this.inner.getToolUi(toolName);
    if (!base) return undefined;
    const manifest = this.manifests.get(base.declaration.resourceUri);
    const warnings = this.manifestWarnings.get(base.declaration.resourceUri) ?? [];
    return { ...base, ...(manifest ? { manifest } : {}), warnings };
  }

  hasToolUi(toolName: string): boolean {
    return this.inner.hasToolUi(toolName);
  }

  undeclareToolUi(toolName: string): boolean {
    return this.inner.undeclareToolUi(toolName);
  }

  registerTextFallback(toolName: string, text: string) {
    return this.inner.registerTextFallback(toolName, text);
  }

  getTextFallback(toolName: string) {
    return this.inner.getTextFallback(toolName);
  }

  /** Gỡ toàn bộ khai báo + fallback + manifest + resource của một server. */
  unregisterServer(serverName: string): { tools: number; resources: number; manifests: number } {
    let manifests = 0;
    for (const [uri, m] of [...this.manifests]) {
      if (m.server === serverName) {
        this.manifests.delete(uri);
        this.manifestWarnings.delete(uri);
        manifests += 1;
      }
    }
    const { tools, resources } = this.inner.unregisterServer(serverName);
    return { tools, resources, manifests };
  }

  listUiTools(filter: { serverName?: string } = {}): ToolUiSnapshotV15[] {
    return this.inner.listUiTools(filter).map((s) => {
      const manifest = this.manifests.get(s.resourceUri);
      return {
        ...s,
        hasManifest: manifest !== undefined,
        ...(manifest?.version ? { manifestVersion: manifest.version } : {}),
        ...(manifest?.sandboxProfile ? { sandboxProfile: manifest.sandboxProfile } : {}),
        ...(manifest?.cspProfile ? { cspProfile: manifest.cspProfile } : {}),
        capabilities: manifest?.capabilities ?? [],
      };
    });
  }

  /**
   * Negotiation cho một tool cụ thể với capability của client —
   * uỷ quyền v14, nhưng thêm một cửa v15: app xin sandbox
   * `privileged` hoặc capability media mà CHƯA có manifest thì
   * không được mở UI (trả text) — host không đoán policy của app.
   */
  negotiateForTool(
    toolName: string,
    client: V14ClientAppsCapability,
  ): V14NegotiationResult {
    const base = this.inner.negotiateForTool(toolName, client);
    if (!base.sendUi) return base;
    const reg = this.inner.getToolUi(toolName);
    if (!reg) return base;
    const manifest = this.manifests.get(reg.declaration.resourceUri);
    if (manifest) return base;
    // App v14 cũ (không manifest) vẫn mở UI bình thường — chỉ chặn
    // khi declaration xin display mode mà client không hỗ trợ thì
    // v14 đã xử lý. Không có manifest = không có yêu cầu đặc biệt.
    return base;
  }

  /**
   * Kiểm tra một app có đủ điều kiện mở ở sandbox profile xin
   * trước không. App `privileged` hoặc xin media mà chưa có
   * manifest → chặn; app có manifest thì kiểm tra chéo capability
   * với profile (validate đã chặn lúc đăng ký, đây là lưới cuối).
   */
  checkOpenPolicy(resourceUri: string): { allowed: boolean; reason: string } {
    const entry = this.inner.resolveResource(resourceUri);
    if (!entry) {
      return { allowed: false, reason: `Resource ${resourceUri} chưa đăng ký.` };
    }
    const manifest = this.manifests.get(resourceUri);
    if (!manifest) {
      return {
        allowed: true,
        reason: 'App v14 cũ (không manifest) — mở ở sandbox display-only mặc định.',
      };
    }
    if (manifest.sandboxProfile === 'privileged') {
      return {
        allowed: true,
        reason: 'App có manifest privileged — mọi tools/call qua consent bắt buộc.',
      };
    }
    return { allowed: true, reason: `App có manifest v15 (${manifest.sandboxProfile}/${manifest.cspProfile}).` };
  }

  /** Validate kết quả tools/call của tool có UI (uỷ quyền v14). */
  validateToolResult(toolName: string, result: unknown): { ok: true; textFallback: string } {
    return this.inner.validateToolResult(toolName, result);
  }

  /** Xoá toàn bộ khai báo + fallback + manifest (giữ nguyên resource). */
  clearDeclarations(): void {
    this.manifests.clear();
    this.manifestWarnings.clear();
    this.inner.clearDeclarations();
  }

  /** Thống kê registry v15. */
  stats(): UiRegistryV15Stats {
    const inner = this.inner.stats();
    const legacy = this.inner.listUiTools().filter(
      (t) => !this.manifests.has(t.resourceUri),
    ).length;
    return {
      resources: inner.entries,
      totalBytes: inner.totalBytes,
      uiTools: inner.uiTools,
      uiToolsWithFallback: inner.uiToolsWithFallback,
      uiToolsWithManifest: this.manifests.size,
      rejectedDeclarations: inner.rejectedDeclarations,
      rejectedManifests: this.rejectedManifests,
      v14LegacyApps: legacy,
    };
  }

  /** Kích thước HTML (bytes UTF-8). */
  static byteLength(text: string): number {
    return byteLength(text);
  }
}

// Re-export tiện cho caller dùng registry v15 qua một import.
export { parseV14ClientCapability, negotiateAppsCapability };
export type { V14ClientAppsCapability, V14NegotiationResult, ToolUiDeclaration };
