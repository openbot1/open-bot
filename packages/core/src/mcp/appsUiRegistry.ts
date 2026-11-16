/**
 * MCP Apps host v13 — registry `ui://` (SEP-1865, ideas only).
 *
 * Host giữ một bảng tra cứu các resource app theo URI `ui://`:
 * tool khai báo `_meta.ui.resourceUri`, server trả resource qua
 * `resources/read` (hoặc kèm trong kết quả `tools/call`), host
 * đăng ký resource vào đây rồi resolve khi cần render.
 *
 * Quy tắc:
 *   - Key là resourceUri đã chuẩn hoá (`ui://server/path`); đăng ký
 *     lại cùng URI thì GHI ĐÈ (server cập nhật app), giữ nguyên
 *     `registeredAtMs` đầu tiên, cập nhật `updatedAtMs` + `version`.
 *   - Chỉ nhận MIME app (`text/html` hoặc `text/html;profile=mcp-app`)
 *     và HTML đã qua `validateAppHtml` — resource lỗi bị từ chối
 *     với lý do rõ ràng, không ghi đè entry cũ đang chạy tốt.
 *   - Không persist ra disk: HTML là nội dung không tin cậy từ
 *     server, chỉ sống trong bộ nhớ của phiên (khớp AppManager).
 *   - Giới hạn: tối đa N entry và tổng M bytes (mặc định 200 entry /
 *     32 MB); vượt thì đuổi entry ít dùng nhất (LRU theo `hits` +
 *     `updatedAtMs`). TTL tuỳ chọn: entry quá hạn bị `pruneExpired`
 *     dọn (mặc định không hết hạn).
 *   - `resolveForTool` tra theo tên tool trước (server + toolName),
 *     rồi mới theo URI — để host mở đúng app của đúng tool khi một
 *     server có nhiều app.
 *
 * Thuần (không DOM, không network), test được bằng node:test.
 */

import { validateAppHtml } from './apps';
import {
  isMcpAppMimeType,
  MCP_APP_PROFILE_MIME_TYPE,
  parseUiMimeType,
  parseUiResourceUri,
  type ToolUiDeclaration,
} from './appsUiMeta';

/** Số entry tối đa trong registry (mặc định). */
export const UI_REGISTRY_MAX_ENTRIES = 200;
/** Tổng bytes HTML tối đa trong registry (mặc định 32 MB). */
export const UI_REGISTRY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export class UiRegistryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UiRegistryError';
    this.code = code;
  }
}

/** Một resource app đã đăng ký trong registry `ui://`. */
export interface UiResourceEntry {
  /** URI đã chuẩn hoá, vd `ui://my-server/dashboard`. */
  uri: string;
  /** Tên MCP server sở hữu resource. */
  serverName: string;
  /** Tên tool đã tạo ra resource (nếu biết). */
  toolName?: string;
  /** Tiêu đề hiển thị. */
  title: string;
  /** HTML đã validate của app. */
  html: string;
  /** MIME đã chuẩn hoá (`text/html` hoặc `text/html;profile=mcp-app`). */
  mimeType: string;
  /** Display mode gợi ý (từ `_meta.ui` của tool, nếu có). */
  displayMode?: ToolUiDeclaration['displayMode'];
  /** Số lần entry được cập nhật (đăng ký lại cùng URI). */
  version: number;
  /** Thời điểm đăng ký lần đầu (ms epoch). */
  registeredAtMs: number;
  /** Thời điểm cập nhật gần nhất (ms epoch). */
  updatedAtMs: number;
  /** Thời điểm resolve gần nhất (ms epoch, cho LRU). */
  lastUsedAtMs: number;
  /** Số lần resolve thành công. */
  hits: number;
  /** Kích thước HTML (bytes UTF-8). */
  sizeBytes: number;
  /** TTL (ms) — hết hạn thì prune dọn; undefined = không hết hạn. */
  ttlMs?: number;
}

/** Input đăng ký một resource app. */
export interface RegisterUiResourceInput {
  uri: string;
  serverName?: string;
  toolName?: string;
  title?: string;
  html: string;
  mimeType?: string;
  displayMode?: ToolUiDeclaration['displayMode'];
  /** TTL (ms) cho entry này. */
  ttlMs?: number;
}

/** Snapshot nhẹ cho UI (không kèm HTML). */
export interface UiResourceSnapshot {
  uri: string;
  serverName: string;
  toolName?: string;
  title: string;
  mimeType: string;
  displayMode?: ToolUiDeclaration['displayMode'];
  version: number;
  registeredAtMs: number;
  updatedAtMs: number;
  hits: number;
  sizeBytes: number;
}

export interface UiRegistryOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

/** Thống kê registry. */
export interface UiRegistryStats {
  entries: number;
  totalBytes: number;
  totalHits: number;
  servers: number;
  evicted: number;
  rejected: number;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Registry `ui://` trong bộ nhớ. Một instance cho toàn bộ desktop
 * (main process); renderer hỏi qua IPC, không tự giữ bản sao.
 */
export class McpAppUiRegistry {
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, UiResourceEntry>();
  private evictedCount = 0;
  private rejectedCount = 0;

  constructor(options: UiRegistryOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? UI_REGISTRY_MAX_ENTRIES);
    this.maxTotalBytes = Math.max(1024, options.maxTotalBytes ?? UI_REGISTRY_MAX_TOTAL_BYTES);
    this.now = options.now ?? Date.now;
  }

  /** Số entry đang giữ. */
  get size(): number {
    return this.entries.size;
  }

  /** Tổng bytes HTML đang giữ. */
  get totalBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.sizeBytes;
    return total;
  }

  /**
   * Đăng ký (hoặc cập nhật) một resource app. Validate URI + MIME +
   * HTML trước; lỗi thì ném `UiRegistryError` và KHÔNG chạm entry cũ.
   */
  register(input: RegisterUiResourceInput): UiResourceEntry {
    const parsed = parseUiResourceUri(input.uri);
    const serverName = input.serverName ?? parsed.server;
    if (serverName !== parsed.server) {
      this.rejectedCount += 1;
      throw new UiRegistryError(
        `serverName "${serverName}" không khớp server trong resourceUri "${parsed.uri}".`,
        'ui-registry-server-mismatch',
      );
    }
    const mimeType = input.mimeType ?? 'text/html';
    if (!isMcpAppMimeType(mimeType)) {
      this.rejectedCount += 1;
      throw new UiRegistryError(
        `MIME "${mimeType}" không phải MIME của MCP App (cần text/html hoặc text/html;profile=mcp-app).`,
        'ui-registry-bad-mime',
      );
    }
    const validation = validateAppHtml(input.html);
    if (!validation.valid) {
      this.rejectedCount += 1;
      const first = validation.findings.find((f) => f.severity === 'blocking');
      throw new UiRegistryError(
        `App ${parsed.uri} bị từ chối: ${first?.message ?? 'validation failed.'}`,
        first?.code ?? 'ui-registry-invalid-html',
      );
    }
    const sizeBytes = byteLength(input.html);
    if (sizeBytes > this.maxTotalBytes) {
      this.rejectedCount += 1;
      throw new UiRegistryError(
        `App ${parsed.uri} quá lớn (${sizeBytes} bytes, registry chỉ chứa tối đa ${this.maxTotalBytes} bytes cho một app).`,
        'ui-registry-too-large',
      );
    }
    const nowMs = this.now();
    const existing = this.entries.get(parsed.uri);
    const entry: UiResourceEntry = {
      uri: parsed.uri,
      serverName,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      title: (input.title ?? parsed.name).slice(0, 120),
      html: input.html,
      mimeType: parseUiMimeType(mimeType).normalized,
      ...(input.displayMode ? { displayMode: input.displayMode } : {}),
      version: (existing?.version ?? 0) + 1,
      registeredAtMs: existing?.registeredAtMs ?? nowMs,
      updatedAtMs: nowMs,
      lastUsedAtMs: nowMs,
      hits: existing?.hits ?? 0,
      sizeBytes,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    };
    this.entries.set(parsed.uri, entry);
    this.evictIfNeeded(parsed.uri);
    return entry;
  }

  /** Đăng ký một tool declaration + HTML của nó (đường tắt thường dùng nhất). */
  registerFromDeclaration(
    declaration: ToolUiDeclaration,
    html: string,
    options: { toolName?: string; title?: string; mimeType?: string; ttlMs?: number } = {},
  ): UiResourceEntry {
    return this.register({
      uri: declaration.resourceUri,
      serverName: declaration.server,
      toolName: options.toolName,
      title: options.title ?? declaration.title ?? declaration.appName,
      html,
      mimeType: options.mimeType ?? MCP_APP_PROFILE_MIME_TYPE,
      displayMode: declaration.displayMode,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
  }

  /** Resolve một URI `ui://` → entry (tăng hits, cập nhật lastUsed). Trả undefined khi không có hoặc đã hết hạn. */
  resolve(uri: string): UiResourceEntry | undefined {
    let parsedUri: string;
    try {
      parsedUri = parseUiResourceUri(uri).uri;
    } catch {
      return undefined;
    }
    const entry = this.entries.get(parsedUri);
    if (!entry) return undefined;
    if (entry.ttlMs !== undefined && this.now() - entry.registeredAtMs > entry.ttlMs) {
      this.entries.delete(parsedUri);
      return undefined;
    }
    entry.hits += 1;
    entry.lastUsedAtMs = this.now();
    return entry;
  }

  /**
   * Resolve app của một tool: ưu tiên entry có đúng `toolName` trên
   * đúng server, rồi mới tới entry theo `resourceUri` trong khai báo.
   */
  resolveForTool(serverName: string, toolName: string, declaration?: ToolUiDeclaration): UiResourceEntry | undefined {
    let best: UiResourceEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.serverName !== serverName || entry.toolName !== toolName) continue;
      if (!best || entry.updatedAtMs > best.updatedAtMs) best = entry;
    }
    if (best) {
      best.hits += 1;
      best.lastUsedAtMs = this.now();
      return best;
    }
    if (declaration) return this.resolve(declaration.resourceUri);
    return undefined;
  }

  /** Entry có tồn tại không (không tăng hits, không kiểm tra TTL). */
  has(uri: string): boolean {
    try {
      return this.entries.has(parseUiResourceUri(uri).uri);
    } catch {
      return false;
    }
  }

  /** Gỡ một entry. Trả true khi entry tồn tại. */
  unregister(uri: string): boolean {
    try {
      return this.entries.delete(parseUiResourceUri(uri).uri);
    } catch {
      return false;
    }
  }

  /** Gỡ toàn bộ entry của một server (vd server ngắt kết nối). Trả số entry đã gỡ. */
  unregisterServer(serverName: string): number {
    let removed = 0;
    for (const [uri, entry] of [...this.entries]) {
      if (entry.serverName === serverName) {
        this.entries.delete(uri);
        removed += 1;
      }
    }
    return removed;
  }

  /** Xoá toàn bộ registry. */
  clear(): void {
    this.entries.clear();
  }

  /** Dọn các entry đã hết TTL. Trả số entry đã dọn. */
  pruneExpired(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [uri, entry] of [...this.entries]) {
      if (entry.ttlMs !== undefined && nowMs - entry.registeredAtMs > entry.ttlMs) {
        this.entries.delete(uri);
        removed += 1;
      }
    }
    return removed;
  }

  /** Danh sách snapshot nhẹ (không kèm HTML), mới cập nhật nhất trước. */
  list(filter: { serverName?: string; toolName?: string } = {}): UiResourceSnapshot[] {
    return [...this.entries.values()]
      .filter(
        (e) =>
          (filter.serverName === undefined || e.serverName === filter.serverName) &&
          (filter.toolName === undefined || e.toolName === filter.toolName),
      )
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((e) => this.snapshot(e));
  }

  /** Toàn bộ entry (kèm HTML) của một server — dùng khi server reconnect và cần re-render. */
  listEntriesForServer(serverName: string): UiResourceEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.serverName === serverName)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** Thống kê registry. */
  stats(): UiRegistryStats {
    const servers = new Set([...this.entries.values()].map((e) => e.serverName)).size;
    let totalHits = 0;
    for (const e of this.entries.values()) totalHits += e.hits;
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      totalHits,
      servers,
      evicted: this.evictedCount,
      rejected: this.rejectedCount,
    };
  }

  private snapshot(entry: UiResourceEntry): UiResourceSnapshot {
    return {
      uri: entry.uri,
      serverName: entry.serverName,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      title: entry.title,
      mimeType: entry.mimeType,
      ...(entry.displayMode ? { displayMode: entry.displayMode } : {}),
      version: entry.version,
      registeredAtMs: entry.registeredAtMs,
      updatedAtMs: entry.updatedAtMs,
      hits: entry.hits,
      sizeBytes: entry.sizeBytes,
    };
  }

  /** Đuổi entry ít dùng nhất cho tới khi vừa giới hạn (không đuổi entry vừa đăng ký). */
  private evictIfNeeded(keepUri: string): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      let victim: UiResourceEntry | undefined;
      for (const candidate of this.entries.values()) {
        if (candidate.uri === keepUri) continue;
        if (
          !victim ||
          candidate.lastUsedAtMs < victim.lastUsedAtMs ||
          (candidate.lastUsedAtMs === victim.lastUsedAtMs && candidate.hits < victim.hits)
        ) {
          victim = candidate;
        }
      }
      if (!victim) break;
      this.entries.delete(victim.uri);
      this.evictedCount += 1;
    }
  }
}
