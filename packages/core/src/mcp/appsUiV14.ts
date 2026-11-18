/**
 * MCP Apps host v14 — registry `ui://` + khai báo `_meta.ui` +
 * text fallback + capability negotiation (SEP-1865 stable 2026-01-26,
 * ideas only — không copy code/text/tài sản của bất kỳ repo nào).
 *
 * V14 siết lại vòng đời mà v13 còn để mở:
 *
 *   1. Khai báo `_meta.ui.resourceUri` của một tool CHỈ hợp lệ khi
 *      resource đó ĐÃ đăng ký trong registry `ui://` (không còn
 *      "khai báo treo" trỏ tới resource không tồn tại), và tool đó
 *      CHỈ được đăng ký khi có text fallback đầy đủ.
 *   2. Text fallback là bắt buộc: mọi tool có UI đều phải trả kèm
 *      bản text đầy đủ cho client không render được (terminal).
 *      Thiếu fallback → từ chối đăng ký, và kết quả tool thiếu text
 *      → host trả text thay vì UI.
 *   3. Capability negotiation: handshake MCP — client khai báo có
 *      render được app không (và render mode nào); server chỉ gửi
 *      UI khi client hỗ trợ, ngược lại progressive enhancement
 *      xuống text. Quyết định negotiation là thuần, test được.
 *
 * Module này thuần (không DOM, không network). Registry v14 bọc
 * `McpAppUiRegistry` v13 để tái dùng validate HTML / LRU / TTL,
 * và thêm lớp khai báo + fallback + negotiation của riêng v14.
 */

import { McpAppUiRegistry, type UiResourceEntry, type UiResourceSnapshot, type UiRegistryStats } from './appsUiRegistry';
import {
  parseToolUiMetaBlock,
  type ToolUiDeclaration,
} from './appsUiMeta';

/** Version của host v14 (ghi vào host context + audit). */
export const MCP_APPS_V14_VERSION = '14.0.0';
/** Protocol version của dialect `ui/` mà v14 nói (khớp v13). */
export const MCP_APPS_V14_PROTOCOL_VERSION = 'ui/1.0';

/** Text fallback tối thiểu (ký tự sau khi trim) — ngắn hơn là không đủ dùng. */
export const UI_V14_TEXT_FALLBACK_MIN_CHARS = 20;
/** Text fallback tối đa (ký tự) — dài hơn thì cắt + đánh dấu đã cắt. */
export const UI_V14_TEXT_FALLBACK_MAX_CHARS = 20_000;
/** Tiêu đề app tối đa (ký tự) — khớp giới hạn của v13. */
export const UI_V14_MAX_TITLE_CHARS = 120;

/** Render mode mà client có thể hỗ trợ (khớp display mode của `_meta.ui`). */
export const UI_V14_RENDER_MODES = ['inline', 'fullscreen', 'pip'] as const;
export type UiV14RenderMode = (typeof UI_V14_RENDER_MODES)[number];

export class McpAppsV14Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpAppsV14Error';
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
// Capability negotiation
// ---------------------------------------------------------------------------

/**
 * Capability MCP Apps mà client khai báo trong handshake.
 * Client gửi khối này trong `capabilities` của `initialize`
 * (open-bot đọc từ `capabilities.apps` hoặc từ khối `apps` riêng
 * của client — xem `parseV14ClientCapability`).
 */
export interface V14ClientAppsCapability {
  /** Client render được app trong iframe sandboxed. */
  supportsApps: boolean;
  /** Các render mode client hỗ trợ (rỗng = không rõ, host tự chọn inline). */
  renderModes: UiV14RenderMode[];
  /** Chiều rộng tối đa client chịu được (px, 0 = không giới hạn). */
  maxWidthPx: number;
  /** Chiều cao tối đa client chịu được (px, 0 = không giới hạn). */
  maxHeightPx: number;
  /** Tên client (để log / audit, không dùng để quyết định). */
  clientName?: string;
}

/** Kết quả negotiation cho một tool cụ thể. */
export interface V14NegotiationResult {
  /** true = gửi UI; false = chỉ gửi text fallback. */
  sendUi: boolean;
  /** Render mode host chọn (chỉ khi sendUi). */
  renderMode?: UiV14RenderMode;
  /** Lý do ngắn gọn, hiển thị được trong log/UI. */
  reason: string;
  /** Mã lý do ổn định cho test + i18n. */
  reasonCode:
    | 'client-supports-apps'
    | 'client-no-apps'
    | 'client-no-render-mode'
    | 'tool-has-no-ui'
    | 'tool-has-no-fallback'
    | 'resource-not-registered';
}

/**
 * Parse khối capability MCP Apps của client từ handshake thô.
 * Chấp nhận 2 vị trí: `capabilities.apps` (chuẩn SEP-1865) và
 * `capabilities.experimental.apps`. Trả capability "không hỗ trợ"
 * khi khối vắng mặt — client cũ không biết Apps thì mặc định text.
 * Ném `McpAppsV14Error` khi khối có mặt nhưng sai định dạng.
 */
export function parseV14ClientCapability(handshake: unknown): V14ClientAppsCapability {
  const none: V14ClientAppsCapability = {
    supportsApps: false,
    renderModes: [],
    maxWidthPx: 0,
    maxHeightPx: 0,
  };
  if (!isRecord(handshake)) return none;
  const caps = handshake['capabilities'];
  if (!isRecord(caps)) return none;
  const raw =
    (isRecord(caps['apps']) ? caps['apps'] : undefined) ??
    (isRecord(caps['experimental']) && isRecord(caps['experimental']['apps'])
      ? (caps['experimental']['apps'] as Record<string, unknown>)
      : undefined);
  if (raw === undefined) return none;
  if (!isRecord(raw)) {
    throw new McpAppsV14Error(
      'capabilities.apps của client phải là object.',
      'ui-v14-bad-capability',
    );
  }
  const renderRaw = raw['render'];
  const supportsApps =
    raw['supportsApps'] === true || raw['render'] === true || renderRaw === true;
  const modesRaw = raw['renderModes'] ?? raw['modes'];
  let renderModes: UiV14RenderMode[] = [];
  if (modesRaw !== undefined) {
    if (!Array.isArray(modesRaw) || modesRaw.some((m) => typeof m !== 'string')) {
      throw new McpAppsV14Error(
        'capabilities.apps.renderModes phải là mảng chuỗi.',
        'ui-v14-bad-capability',
      );
    }
    const unknownMode = (modesRaw as string[]).find(
      (m) => !(UI_V14_RENDER_MODES as readonly string[]).includes(m),
    );
    if (unknownMode !== undefined) {
      throw new McpAppsV14Error(
        `Render mode không rõ trong capabilities.apps: "${unknownMode}".`,
        'ui-v14-bad-capability',
      );
    }
    renderModes = [...new Set(modesRaw as UiV14RenderMode[])];
  }
  const maxWidth = raw['maxWidthPx'];
  const maxHeight = raw['maxHeightPx'];
  for (const [field, value] of [
    ['maxWidthPx', maxWidth],
    ['maxHeightPx', maxHeight],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      throw new McpAppsV14Error(
        `capabilities.apps.${field} phải là số không âm.`,
        'ui-v14-bad-capability',
      );
    }
  }
  const clientName = asNonEmptyString(raw['clientName']) ?? asNonEmptyString(handshake['clientName']);
  return {
    supportsApps,
    renderModes,
    maxWidthPx: typeof maxWidth === 'number' ? Math.floor(maxWidth) : 0,
    maxHeightPx: typeof maxHeight === 'number' ? Math.floor(maxHeight) : 0,
    ...(clientName ? { clientName } : {}),
  };
}

/**
 * Quyết định có gửi UI cho client này không.
 *
 * Thứ tự kiểm tra (fail-closed, lý do đầu tiên thắng):
 *   1. Tool không khai báo UI → không gửi UI.
 *   2. Tool thiếu text fallback → không gửi UI (và host PHẢI
 *      báo lỗi đăng ký ở tầng registry — đây là lưới an toàn cuối).
 *   3. Resource chưa đăng ký → không gửi UI.
 *   4. Client không hỗ trợ Apps → text.
 *   5. Client hỗ trợ nhưng không có render mode chung với tool
 *      (tool xin `pip`, client chỉ `inline`) → text.
 *   6. Còn lại → gửi UI với render mode chung đầu tiên (ưu tiên
 *      mode tool xin, rồi tới mode client liệt kê đầu tiên).
 */
export function negotiateAppsCapability(
  client: V14ClientAppsCapability,
  tool: {
    declaration: ToolUiDeclaration | null;
    hasTextFallback: boolean;
    resourceRegistered: boolean;
  },
): V14NegotiationResult {
  if (!tool.declaration) {
    return { sendUi: false, reason: 'Tool không khai báo UI.', reasonCode: 'tool-has-no-ui' };
  }
  if (!tool.hasTextFallback) {
    return {
      sendUi: false,
      reason: 'Tool có UI nhưng thiếu text fallback bắt buộc.',
      reasonCode: 'tool-has-no-fallback',
    };
  }
  if (!tool.resourceRegistered) {
    return {
      sendUi: false,
      reason: `Resource ${tool.declaration.resourceUri} chưa đăng ký trong registry ui://.`,
      reasonCode: 'resource-not-registered',
    };
  }
  if (!client.supportsApps) {
    return {
      sendUi: false,
      reason: 'Client không hỗ trợ MCP Apps — trả text fallback.',
      reasonCode: 'client-no-apps',
    };
  }
  const wanted = tool.declaration.displayMode ?? 'inline';
  const modes = client.renderModes.length > 0 ? client.renderModes : ['inline' as UiV14RenderMode];
  if (!modes.includes(wanted)) {
    return {
      sendUi: false,
      reason: `Client không hỗ trợ render mode "${wanted}" mà tool xin — trả text fallback.`,
      reasonCode: 'client-no-render-mode',
    };
  }
  return {
    sendUi: true,
    renderMode: wanted,
    reason: `Client hỗ trợ MCP Apps (mode ${wanted}).`,
    reasonCode: 'client-supports-apps',
  };
}

/** Clamp kích thước gợi ý của tool theo giới hạn client khai báo. */
export function clampPreferredSizeForClient(
  declaration: ToolUiDeclaration,
  client: V14ClientAppsCapability,
): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  if (declaration.preferredWidth !== undefined) {
    out.width =
      client.maxWidthPx > 0
        ? Math.min(declaration.preferredWidth, client.maxWidthPx)
        : declaration.preferredWidth;
  }
  if (declaration.preferredHeight !== undefined) {
    out.height =
      client.maxHeightPx > 0
        ? Math.min(declaration.preferredHeight, client.maxHeightPx)
        : declaration.preferredHeight;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text fallback
// ---------------------------------------------------------------------------

/** Một text fallback đã đăng ký cho tool. */
export interface UiTextFallback {
  toolName: string;
  /** Bản text đầy đủ (đã trim + cắt ở mức tối đa). */
  text: string;
  /** Số ký tự của bản text (sau khi cắt). */
  charCount: number;
  /** true khi bản text đã bị cắt vì quá dài. */
  truncated: boolean;
  /** Thời điểm đăng ký/cập nhật (ms epoch). */
  updatedAtMs: number;
}

/**
 * Validate + chuẩn hoá một text fallback thô. Ném `McpAppsV14Error`
 * khi rỗng, quá ngắn (không đủ thông tin cho client text-only),
 * hoặc không phải chuỗi.
 */
export function validateTextFallback(toolName: string, text: unknown): UiTextFallback {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new McpAppsV14Error(
      `Tool "${toolName}" thiếu text fallback: mọi tool có UI đều phải có bản text đầy đủ cho client không render được.`,
      'ui-v14-missing-fallback',
    );
  }
  const trimmed = text.trim();
  if (trimmed.length < UI_V14_TEXT_FALLBACK_MIN_CHARS) {
    throw new McpAppsV14Error(
      `Text fallback của tool "${toolName}" quá ngắn (${trimmed.length} ký tự, tối thiểu ${UI_V14_TEXT_FALLBACK_MIN_CHARS}) — phải mô tả đầy đủ nội dung mà UI hiển thị.`,
      'ui-v14-fallback-too-short',
    );
  }
  const truncated = trimmed.length > UI_V14_TEXT_FALLBACK_MAX_CHARS;
  const finalText = truncated
    ? `${trimmed.slice(0, UI_V14_TEXT_FALLBACK_MAX_CHARS)}\n…(đã cắt bớt)`
    : trimmed;
  return {
    toolName,
    text: finalText,
    charCount: finalText.length,
    truncated,
    updatedAtMs: Date.now(),
  };
}

/**
 * Trích text fallback từ một kết quả `tools/call` thô: gom toàn bộ
 * block `{ type: 'text', text }` (bỏ block resource/app). Trả chuỗi
 * rỗng khi kết quả không có text nào — caller quyết định chặn.
 */
export function extractTextFallbackFromResult(result: unknown): string {
  if (!isRecord(result)) return '';
  const content = result['content'];
  if (!Array.isArray(content)) {
    const text = asNonEmptyString(result['text']);
    return text ?? '';
  }
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (!isRecord(block)) continue;
    if (block['type'] !== 'text') continue;
    const text = asNonEmptyString(block['text']);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

/** True khi kết quả tool có text fallback dùng được (>= mức tối thiểu). */
export function resultHasTextFallback(result: unknown): boolean {
  return extractTextFallbackFromResult(result).length >= UI_V14_TEXT_FALLBACK_MIN_CHARS;
}

// ---------------------------------------------------------------------------
// Registry v14
// ---------------------------------------------------------------------------

/** Một tool đã khai báo UI trong registry v14. */
export interface ToolUiRegistrationV14 {
  toolName: string;
  serverName: string;
  declaration: ToolUiDeclaration;
  /** Text fallback mẫu đã đăng ký cùng khai báo. */
  textFallback: UiTextFallback;
  /** Thời điểm đăng ký lần đầu (ms epoch). */
  registeredAtMs: number;
  /** Thời điểm cập nhật gần nhất (ms epoch). */
  updatedAtMs: number;
  /** Số lần khai báo được cập nhật. */
  version: number;
}

/** Snapshot nhẹ của một tool có UI (không kèm HTML/fallback đầy đủ). */
export interface ToolUiSnapshotV14 {
  toolName: string;
  serverName: string;
  resourceUri: string;
  appName: string;
  displayMode?: UiV14RenderMode;
  /** Resource đã đăng ký trong registry ui:// chưa. */
  resourceRegistered: boolean;
  /** Đã có text fallback chưa. */
  hasTextFallback: boolean;
  fallbackChars: number;
  version: number;
  updatedAtMs: number;
}

export interface McpAppsUiRegistryV14Options {
  now?: () => number;
  /** Registry v13 dùng chung (mặc định: tạo mới). */
  innerRegistry?: McpAppUiRegistry;
  /** Giới hạn số tool khai báo UI (mặc định 500). */
  maxTools?: number;
}

/** Thống kê registry v14. */
export interface UiRegistryV14Stats extends UiRegistryStats {
  uiTools: number;
  uiToolsWithFallback: number;
  rejectedDeclarations: number;
}

/**
 * Registry v14 — bọc registry `ui://` v13 và thêm:
 *   - bảng khai báo `_meta.ui` theo tool (tool → declaration),
 *   - bảng text fallback theo tool (tool → bản text),
 *   - luật "khai báo chỉ hợp lệ khi resource đã đăng ký + có fallback",
 *   - negotiation theo capability client.
 *
 * Luồng đăng ký đúng thứ tự:
 *   1. `registerResource(...)` — đăng ký HTML vào registry `ui://`.
 *   2. `declareToolUi(toolName, uiMeta, textFallback)` — khai báo
 *      tool + fallback; validate resourceUri trỏ tới resource đã
 *      đăng ký ở bước 1, thiếu fallback thì từ chối.
 * Đăng ký ngược thứ tự (khai báo trước, resource sau) bị từ chối —
 * tool phải sửa thứ tự, không được để khai báo treo.
 */
export class McpAppsUiRegistryV14 {
  /** Registry `ui://` v13 bên dưới (HTML + LRU + TTL). */
  readonly inner: McpAppUiRegistry;
  private readonly now: () => number;
  private readonly maxTools: number;
  private readonly tools = new Map<string, ToolUiRegistrationV14>();
  private readonly fallbacks = new Map<string, UiTextFallback>();
  private rejectedDeclarations = 0;

  constructor(options: McpAppsUiRegistryV14Options = {}) {
    this.now = options.now ?? Date.now;
    this.inner = options.innerRegistry ?? new McpAppUiRegistry({ now: this.now });
    this.maxTools = Math.max(1, options.maxTools ?? 500);
  }

  /** Số tool đã khai báo UI. */
  get size(): number {
    return this.tools.size;
  }

  // -- resource ui:// (uỷ quyền cho registry v13) -------------------------

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
    // V14 siết thêm một cửa so với v13: chỉ nhận HTML document đầy
    // đủ (v1 không nhận đoạn HTML lẻ hay website nhúng ngoài).
    // Kiểm tra tại đây bằng regex + validateAppHtml của v0.98
    // (không import từ appsPreviewV14 để tránh chu trình import —
    // quét thoát sandbox đầy đủ chạy tiếp ở tầng frame build).
    const isFullDocument =
      /<!doctype html>/i.test(input.html) && /<html[\s>]/i.test(input.html);
    if (!isFullDocument) {
      throw new McpAppsV14Error(
        `App ${input.uri} bị từ chối: App v14 phải là HTML document đầy đủ (<!doctype html><html>…) — v1 không nhận đoạn HTML lẻ hay website nhúng ngoài.`,
        'ui-v14-invalid-html-document',
      );
    }
    return this.inner.register(input);
  }

  resolveResource(uri: string): UiResourceEntry | undefined {
    return this.inner.resolve(uri);
  }

  hasResource(uri: string): boolean {
    return this.inner.has(uri);
  }

  unregisterResource(uri: string): boolean {
    const removed = this.inner.unregister(uri);
    return removed;
  }

  listResources(filter: { serverName?: string; toolName?: string } = {}): UiResourceSnapshot[] {
    return this.inner.list(filter);
  }

  // -- text fallback ---------------------------------------------------------

  /**
   * Đăng ký (hoặc cập nhật) text fallback cho một tool. Fallback
   * sống độc lập với khai báo UI — tool có thể đăng ký fallback
   * trước rồi khai báo UI sau, nhưng khai báo UI không hoàn tất
   * nếu chưa có fallback (xem `declareToolUi`).
   */
  registerTextFallback(toolName: string, text: string): UiTextFallback {
    const name = asNonEmptyString(toolName);
    if (!name) {
      throw new McpAppsV14Error('toolName rỗng.', 'ui-v14-bad-tool-name');
    }
    const fallback = validateTextFallback(name, text);
    fallback.updatedAtMs = this.now();
    this.fallbacks.set(name, fallback);
    const reg = this.tools.get(name);
    if (reg) {
      reg.textFallback = fallback;
      reg.updatedAtMs = this.now();
    }
    return fallback;
  }

  getTextFallback(toolName: string): UiTextFallback | undefined {
    return this.fallbacks.get(toolName);
  }

  hasTextFallback(toolName: string): boolean {
    return this.fallbacks.has(toolName);
  }

  // -- khai báo _meta.ui ------------------------------------------------------

  /**
   * Khai báo UI cho một tool (`_meta.ui` + text fallback bắt buộc).
   *
   * Ném `McpAppsV14Error` khi:
   *   - `_meta.ui` sai định dạng (URI sai, displayMode lạ, ...),
   *   - resourceUri chưa đăng ký trong registry `ui://`,
   *   - thiếu text fallback (chưa đăng ký fallback cho tool này
   *     và cũng không truyền kèm trong lần gọi này),
   *   - tool đã khai báo mà resource đăng ký thuộc server khác.
   * Đăng ký lại cùng toolName thì cập nhật (tăng version).
   */
  declareToolUi(
    toolName: string,
    uiMeta: unknown,
    options: { textFallback?: string; serverName?: string } = {},
  ): ToolUiRegistrationV14 {
    const name = asNonEmptyString(toolName);
    if (!name) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error('toolName rỗng.', 'ui-v14-bad-tool-name');
    }
    let declaration: ToolUiDeclaration;
    try {
      const parsed = parseToolUiMetaBlock(uiMeta);
      if (!parsed) {
        this.rejectedDeclarations += 1;
        throw new McpAppsV14Error(
          `Tool "${name}" khai báo _meta.ui rỗng — phải có resourceUri.`,
          'ui-v14-bad-meta',
        );
      }
      declaration = parsed;
    } catch (err) {
      this.rejectedDeclarations += 1;
      throw err;
    }
    // Resource phải ĐÃ đăng ký — không khai báo treo.
    const entry = this.inner.resolve(declaration.resourceUri);
    if (!entry) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error(
        `Tool "${name}" khai báo app ${declaration.resourceUri} nhưng resource chưa đăng ký trong registry ui:// — đăng ký resource trước rồi mới khai báo tool.`,
        'ui-v14-unregistered-resource',
      );
    }
    if (options.serverName !== undefined && options.serverName !== entry.serverName) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error(
        `Tool "${name}" thuộc server "${options.serverName}" nhưng resource ${declaration.resourceUri} thuộc server "${entry.serverName}".`,
        'ui-v14-server-mismatch',
      );
    }
    if (entry.serverName !== declaration.server) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error(
        `Resource ${declaration.resourceUri} thuộc server "${entry.serverName}" nhưng _meta.ui khai báo server "${declaration.server}".`,
        'ui-v14-server-mismatch',
      );
    }
    // Text fallback bắt buộc — lấy từ tham số lần này hoặc đã đăng ký trước.
    let fallback = this.fallbacks.get(name);
    if (options.textFallback !== undefined) {
      fallback = this.registerTextFallback(name, options.textFallback);
    }
    if (!fallback) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error(
        `Tool "${name}" thiếu text fallback: mọi tool có UI đều phải đăng ký bản text đầy đủ cho client không render được (terminal).`,
        'ui-v14-missing-fallback',
      );
    }
    if (this.tools.size >= this.maxTools && !this.tools.has(name)) {
      this.rejectedDeclarations += 1;
      throw new McpAppsV14Error(
        `Registry v14 đã đầy (${this.maxTools} tool có UI).`,
        'ui-v14-registry-full',
      );
    }
    const nowMs = this.now();
    const existing = this.tools.get(name);
    const registration: ToolUiRegistrationV14 = {
      toolName: name,
      serverName: entry.serverName,
      declaration,
      textFallback: fallback,
      registeredAtMs: existing?.registeredAtMs ?? nowMs,
      updatedAtMs: nowMs,
      version: (existing?.version ?? 0) + 1,
    };
    this.tools.set(name, registration);
    return registration;
  }

  /** Khai báo UI của một tool (undefined khi tool không khai báo). */
  getToolUi(toolName: string): ToolUiRegistrationV14 | undefined {
    return this.tools.get(toolName);
  }

  /** True khi tool đã khai báo UI hợp lệ. */
  hasToolUi(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** Gỡ khai báo UI của một tool (giữ lại resource + fallback). */
  undeclareToolUi(toolName: string): boolean {
    return this.tools.delete(toolName);
  }

  /** Gỡ toàn bộ khai báo + fallback + resource của một server. */
  unregisterServer(serverName: string): { tools: number; resources: number } {
    let tools = 0;
    for (const [name, reg] of [...this.tools]) {
      if (reg.serverName === serverName) {
        this.tools.delete(name);
        this.fallbacks.delete(name);
        tools += 1;
      }
    }
    const resources = this.inner.unregisterServer(serverName);
    return { tools, resources };
  }

  /**
   * Liệt kê tool nào có UI — kèm trạng thái resource + fallback
   * để UI/panel hiện cảnh báo khi có tool khai báo treo.
   */
  listUiTools(filter: { serverName?: string } = {}): ToolUiSnapshotV14[] {
    return [...this.tools.values()]
      .filter((r) => filter.serverName === undefined || r.serverName === filter.serverName)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((r) => ({
        toolName: r.toolName,
        serverName: r.serverName,
        resourceUri: r.declaration.resourceUri,
        appName: r.declaration.appName,
        ...(r.declaration.displayMode ? { displayMode: r.declaration.displayMode } : {}),
        resourceRegistered: this.inner.has(r.declaration.resourceUri),
        hasTextFallback: true,
        fallbackChars: r.textFallback.charCount,
        version: r.version,
        updatedAtMs: r.updatedAtMs,
      }));
  }

  /**
   * Negotiation cho một tool cụ thể với capability của client.
   * Dùng trạng thái thật của registry (resource + fallback).
   */
  negotiateForTool(
    toolName: string,
    client: V14ClientAppsCapability,
  ): V14NegotiationResult {
    const reg = this.tools.get(toolName);
    return negotiateAppsCapability(client, {
      declaration: reg?.declaration ?? null,
      hasTextFallback: reg !== undefined || this.fallbacks.has(toolName),
      resourceRegistered:
        reg !== undefined ? this.inner.has(reg.declaration.resourceUri) : false,
    });
  }

  /**
   * Validate kết quả `tools/call` của một tool có UI trước khi
   * render: kết quả PHẢI chứa text fallback dùng được, nếu không
   * host từ chối mở UI (trả lỗi rõ ràng để tool sửa).
   */
  validateToolResult(toolName: string, result: unknown): { ok: true; textFallback: string } {
    const reg = this.tools.get(toolName);
    if (!reg) {
      throw new McpAppsV14Error(
        `Tool "${toolName}" không khai báo UI — không có gì để validate.`,
        'ui-v14-tool-has-no-ui',
      );
    }
    const text = extractTextFallbackFromResult(result);
    if (text.length < UI_V14_TEXT_FALLBACK_MIN_CHARS) {
      throw new McpAppsV14Error(
        `Kết quả của tool "${toolName}" thiếu text fallback (chỉ ${text.length} ký tự text, tối thiểu ${UI_V14_TEXT_FALLBACK_MIN_CHARS}) — client không render được sẽ không thấy gì.`,
        'ui-v14-result-missing-fallback',
      );
    }
    return { ok: true as const, textFallback: text };
  }

  /** Xoá toàn bộ khai báo + fallback (giữ nguyên resource ui://). */
  clearDeclarations(): void {
    this.tools.clear();
    this.fallbacks.clear();
  }

  /** Thống kê registry v14 (gồm cả thống kê registry v13 bên dưới). */
  stats(): UiRegistryV14Stats {
    const inner = this.inner.stats();
    return {
      ...inner,
      uiTools: this.tools.size,
      uiToolsWithFallback: [...this.tools.values()].filter(
        (r) => r.textFallback.charCount >= UI_V14_TEXT_FALLBACK_MIN_CHARS,
      ).length,
      rejectedDeclarations: this.rejectedDeclarations,
    };
  }

  /** Kích thước HTML (bytes UTF-8) — dùng chung cho giới hạn registry. */
  static byteLength(text: string): number {
    return byteLength(text);
  }
}
