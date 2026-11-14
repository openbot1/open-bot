/**
 * MCP Apps v2 — cache manifest theo app version + security review
 * (v1.05, sóng T2).
 *
 * `appsV2.ts` (v1.04) đã có prefetch + `AppPrefetchCache` (TTL +
 * cap bytes) và review template — nhưng còn thiếu hai mảnh để
 * Apps v2 hoàn chỉnh:
 *
 *   1. Cache manifest theo app version: `AppPrefetchCache` không
 *      biết template thuộc version nào — khi server bump version,
 *      resource cũ (cùng URI, nội dung mới) vẫn được coi là fresh
 *      tới hết TTL. `AppCacheManifest` ghi lại, cho mỗi template
 *      + version, fingerprint của declaration + danh sách URI đã
 *      prefetch; `invalidateOnVersionChange()` xoá toàn bộ cache
 *      của version cũ ngay khi version đổi, không chờ TTL. Manifest
 *      serialize được ra JSON để host giữ qua restart.
 *   2. Security-review UI template: trước khi chạy một app, host
 *      phải cho user thấy app xin quyền gì — `buildSecurityReview`
 *      tổng hợp từ declaration: tools (UI được gọi tool nào),
 *      roots (app có xin đọc workspace không), network (host nào
 *      được phép fetch / load media), dữ liệu (prefetch resource
 *      nào), kèm mức rủi ro (`low` / `medium` / `high`) và danh
 *      sách cảnh báo để UI render (xem component
 *      `McpAppSecurityReview.tsx`).
 *
 * Không chạm mạng, không copy code từ SDK MCP nào.
 */

import {
  AppPrefetchCache,
  appActionAllowed,
  requiresReviewWarning,
  type AppTemplateDeclaration,
  type AppUiActionKind,
  type DeclaredAppTemplate,
} from './appsV2';

/** Version của format manifest (đổi khi shape đổi). */
export const APP_CACHE_MANIFEST_FORMAT_VERSION = 1;

/** Một entry manifest: template + version + resource đã prefetch. */
export interface AppCacheManifestEntry {
  /** Template id. */
  templateId: string;
  /** Version của app/template (vd semver server khai). */
  version: string;
  /** Fingerprint của declaration (xem appsV2.ts declareAppTemplate). */
  fingerprint: string;
  /** URI đã prefetch cho version này. */
  uris: string[];
  /** Khi nào entry được ghi (ms epoch). */
  recordedAt: number;
}

/** Toàn bộ manifest (serialize được ra JSON). */
export interface AppCacheManifestFile {
  formatVersion: number;
  savedAtMs: number;
  entries: AppCacheManifestEntry[];
}

export class AppCacheManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCacheManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Manifest cache prefetch theo app version.
 *
 * Luồng: server khai version mới cho một template → host gọi
 * `recordPrefetch(template, version, uris)` sau khi prefetch xong
 * → lần sau, trước khi dùng cache, host gọi
 * `invalidateOnVersionChange(template, version, cache)`; nếu
 * version trong manifest khác version hiện tại (hoặc fingerprint
 * đổi — declaration bị sửa), cache cũ bị xoá và manifest ghi lại.
 */
export class AppCacheManifest {
  private readonly entries = new Map<string, AppCacheManifestEntry>();
  private readonly nowMs: () => number;

  constructor(options: { nowMs?: () => number } = {}) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  private key(templateId: string): string {
    return templateId;
  }

  /** Số entry trong manifest. */
  get size(): number {
    return this.entries.size;
  }

  /** Lấy entry của một template (undefined khi chưa có). */
  get(templateId: string): AppCacheManifestEntry | undefined {
    const entry = this.entries.get(this.key(templateId));
    return entry ? { ...entry, uris: [...entry.uris] } : undefined;
  }

  /**
   * Ghi lại: template này, ở version này (fingerprint này), đã
   * prefetch các URI này. Ghi đè entry cũ của cùng template.
   */
  recordPrefetch(
    template: DeclaredAppTemplate,
    version: string,
    uris: string[],
  ): AppCacheManifestEntry {
    const cleanVersion = typeof version === 'string' ? version.trim() : '';
    if (cleanVersion.length === 0) {
      throw new AppCacheManifestError(
        `Manifest cần version không rỗng cho template "${template.id}".`,
      );
    }
    const entry: AppCacheManifestEntry = {
      templateId: template.id,
      version: cleanVersion,
      fingerprint: template.fingerprint,
      uris: [...new Set(uris)],
      recordedAt: this.nowMs(),
    };
    this.entries.set(this.key(template.id), entry);
    return { ...entry, uris: [...entry.uris] };
  }

  /**
   * Kiểm tra version/fingerprint hiện tại với manifest; khi khác
   * (version bump hoặc declaration bị sửa), xoá toàn bộ cache của
   * template trong `cache` và cập nhật manifest thành entry mới
   * (chưa có URI — prefetch sẽ ghi lại sau).
   * Trả `{ invalidated: true, reason }` khi đã xoá, hoặc
   * `{ invalidated: false }` khi cache vẫn dùng được.
   */
  invalidateOnVersionChange(
    template: DeclaredAppTemplate,
    version: string,
    cache: AppPrefetchCache,
  ): { invalidated: boolean; reason?: string; previousVersion?: string } {
    const cleanVersion = typeof version === 'string' ? version.trim() : '';
    const entry = this.entries.get(this.key(template.id));
    if (!entry) {
      // Chưa có manifest: ghi entry rỗng để lần sau so được.
      this.recordPrefetch(template, cleanVersion || 'unknown', []);
      return { invalidated: false };
    }
    if (cleanVersion && entry.version !== cleanVersion) {
      const previousVersion = entry.version;
      cache.invalidate(template.id);
      this.recordPrefetch(template, cleanVersion, []);
      return {
        invalidated: true,
        reason: `App "${template.id}" đổi version ${previousVersion} → ${cleanVersion} — cache prefetch cũ đã xoá.`,
        previousVersion,
      };
    }
    if (entry.fingerprint !== template.fingerprint) {
      cache.invalidate(template.id);
      this.recordPrefetch(template, entry.version, []);
      return {
        invalidated: true,
        reason: `App "${template.id}" đổi declaration (fingerprint khác) — cache prefetch cũ đã xoá.`,
        previousVersion: entry.version,
      };
    }
    return { invalidated: false };
  }

  /**
   * Kiểm tra một URI có nằm trong manifest của template+version
   * không (để UI/diagnostics biết resource nào đã prefetch cho
   * đúng version đang chạy).
   */
  hasUri(templateId: string, version: string, uri: string): boolean {
    const entry = this.entries.get(this.key(templateId));
    return !!entry && entry.version === version && entry.uris.includes(uri);
  }

  /** Xoá entry của một template (vd template bị gỡ). */
  remove(templateId: string): boolean {
    return this.entries.delete(this.key(templateId));
  }

  /** Xoá toàn bộ manifest. */
  clear(): void {
    this.entries.clear();
  }

  /** Serialize manifest ra JSON-safe object (để host lưu đĩa). */
  toJSON(): AppCacheManifestFile {
    return {
      formatVersion: APP_CACHE_MANIFEST_FORMAT_VERSION,
      savedAtMs: this.nowMs(),
      entries: [...this.entries.values()].map((e) => ({ ...e, uris: [...e.uris] })),
    };
  }

  /**
   * Khôi phục manifest từ JSON đã lưu. Entry sai hình bị bỏ qua
   * (đếm vào `skipped`); format version khác thì bỏ toàn bộ và
   * trả `skipped` = tổng số entry.
   */
  static fromJSON(
    value: unknown,
    options: { nowMs?: () => number } = {},
  ): { manifest: AppCacheManifest; skipped: number } {
    const manifest = new AppCacheManifest(options);
    let skipped = 0;
    if (!isRecord(value) || !Array.isArray(value['entries'])) {
      return { manifest, skipped: 0 };
    }
    if (value['formatVersion'] !== APP_CACHE_MANIFEST_FORMAT_VERSION) {
      return { manifest, skipped: (value['entries'] as unknown[]).length };
    }
    for (const item of value['entries'] as unknown[]) {
      if (!isRecord(item)) {
        skipped += 1;
        continue;
      }
      const templateId = item['templateId'];
      const version = item['version'];
      const fingerprint = item['fingerprint'];
      const uris = item['uris'];
      const recordedAt = item['recordedAt'];
      if (
        typeof templateId !== 'string' ||
        typeof version !== 'string' ||
        typeof fingerprint !== 'string' ||
        !Array.isArray(uris) ||
        !uris.every((u) => typeof u === 'string') ||
        typeof recordedAt !== 'number'
      ) {
        skipped += 1;
        continue;
      }
      manifest.entries.set(templateId, {
        templateId,
        version,
        fingerprint,
        uris: [...(uris as string[])],
        recordedAt,
      });
    }
    return { manifest, skipped };
  }
}

/** Mức rủi ro tổng hợp của một app (cho security review UI). */
export type AppRiskLevel = 'low' | 'medium' | 'high';

/** Một quyền app xin (hiển thị trong security review UI). */
export interface AppRequestedPermission {
  /** Nhóm quyền: tools / roots / network / data / actions. */
  kind: 'tools' | 'roots' | 'network' | 'data' | 'actions';
  /** Nhãn hiển thị. */
  label: string;
  /** Chi tiết (vd tên tool, host). */
  detail?: string;
  /** Quyền này có làm tăng rủi ro không. */
  risky: boolean;
}

/** Kết quả security review cho một app template. */
export interface AppSecurityReview {
  templateId: string;
  title: string;
  serverName: string;
  /** Version app (khi host biết). */
  version?: string;
  /** Trạng thái review hiện tại. */
  review: DeclaredAppTemplate['review'];
  /** True khi host phải hiện cảnh báo trước khi render. */
  requiresWarning: boolean;
  /** Fingerprint rút gọn (12 ký tự đầu) để UI hiển thị. */
  fingerprintShort: string;
  /** Mức rủi ro tổng hợp. */
  risk: AppRiskLevel;
  /** Mọi quyền app xin, theo nhóm. */
  permissions: AppRequestedPermission[];
  /** Cảnh báo cụ thể (vd "chưa review", "được gọi tool X"). */
  warnings: string[];
  /** Tóm tắt một dòng cho list UI. */
  summary: string;
}

/**
 * Lấy host từ một prefetch URI (https://host/... → host,
 * ui://... → '(app-local)').
 */
export function prefetchUriHost(uri: string): string {
  if (uri.startsWith('ui://')) return '(app-local)';
  try {
    return new URL(uri).hostname;
  } catch {
    return '(không rõ)';
  }
}

/**
 * Build security review cho một app template: tổng hợp mọi quyền
 * app xin từ declaration — tools (allowedActions tool-call +
 * toolName), roots (khi app xin workspace — khai qua
 * `experimental` của declaration hoặc detail), network
 * (allowedHosts + host của prefetch URI), data (prefetch
 * resource), actions (các UI action còn lại). Mức rủi ro:
 *  - `high`: template bị rejected, hoặc được gọi tool + chưa
 *    review, hoặc xin network host ngoài allowlist.
 *  - `medium`: chưa review, hoặc xin network / tool-call.
 *  - `low`: đã approved/reviewed và chỉ render (không action).
 */
export function buildSecurityReview(
  template: DeclaredAppTemplate,
  options: {
    version?: string;
    /** Tool cụ thể UI được gọi (khi host biết rõ hơn toolName). */
    toolNames?: string[];
    /** App có xin đọc workspace roots không. */
    requestsRoots?: boolean;
  } = {},
): AppSecurityReview {
  const permissions: AppRequestedPermission[] = [];
  const warnings: string[] = [];

  const canCallTools = appActionAllowed(template, 'tool-call');
  if (canCallTools) {
    const tools = options.toolNames ?? (template.toolName ? [template.toolName] : []);
    permissions.push({
      kind: 'tools',
      label: 'Gọi tool',
      detail: tools.length > 0 ? tools.join(', ') : 'bất kỳ tool nào server cho phép',
      risky: true,
    });
  }
  if (options.requestsRoots) {
    permissions.push({
      kind: 'roots',
      label: 'Đọc workspace (roots)',
      detail: 'app xin danh sách thư mục làm việc của bạn',
      risky: true,
    });
  }
  const networkHosts = new Set<string>();
  for (const host of template.allowedHosts) networkHosts.add(host);
  for (const resource of template.prefetch) {
    const host = prefetchUriHost(resource.uri);
    if (host !== '(app-local)') networkHosts.add(host);
  }
  if (networkHosts.size > 0) {
    permissions.push({
      kind: 'network',
      label: 'Truy cập mạng',
      detail: [...networkHosts].join(', '),
      risky: true,
    });
  }
  for (const resource of template.prefetch) {
    permissions.push({
      kind: 'data',
      label: 'Prefetch dữ liệu',
      detail: `${resource.uri}${resource.purpose ? ` — ${resource.purpose}` : ''}`,
      risky: false,
    });
  }
  const otherActions = template.allowedActions.filter((a) => a !== 'tool-call');
  for (const action of otherActions) {
    permissions.push({
      kind: 'actions',
      label: `UI action: ${action}`,
      risky: action === 'form-submit',
    });
  }

  const requiresWarning = requiresReviewWarning(template);
  if (template.review === 'unreviewed') {
    warnings.push('App chưa được review — kiểm tra quyền bên dưới trước khi cho chạy.');
  }
  if (template.review === 'rejected') {
    warnings.push('App đã bị từ chối review — không nên chạy.');
  }
  if (canCallTools && template.review === 'unreviewed') {
    warnings.push('App chưa review mà được gọi tool — tool có thể tác động ngoài máy.');
  }
  if (template.prefetch.length === 0 && networkHosts.size > 0) {
    warnings.push('App xin truy cập mạng nhưng không prefetch gì — kiểm tra host được phép.');
  }

  let risk: AppRiskLevel = 'low';
  if (template.review === 'rejected' || (canCallTools && template.review === 'unreviewed')) {
    risk = 'high';
  } else if (requiresWarning || canCallTools || networkHosts.size > 0 || options.requestsRoots) {
    risk = 'medium';
  }

  const permissionSummary =
    permissions.length === 0
      ? 'không xin quyền gì (chỉ hiển thị)'
      : permissions.map((p) => p.label).join(', ');
  const summary =
    `${template.title} (${template.id}) — review: ${template.review}, ` +
    `rủi ro: ${risk}, quyền: ${permissionSummary}.`;

  return {
    templateId: template.id,
    title: template.title,
    serverName: template.serverName,
    ...(options.version ? { version: options.version } : {}),
    review: template.review,
    requiresWarning,
    fingerprintShort: template.fingerprint.slice(0, 12),
    risk,
    permissions,
    warnings,
    summary,
  };
}

/** Mô tả ngắn quyền của app (dùng trong list UI / log). */
export function describeAppPermissions(review: AppSecurityReview): string {
  if (review.permissions.length === 0) return `${review.title}: không xin quyền gì.`;
  const parts = review.permissions.map((p) =>
    p.detail ? `${p.label} (${p.detail})` : p.label,
  );
  return `${review.title}: ${parts.join('; ')}.`;
}

/**
 * Kiểm tra một template có đủ điều kiện chạy không theo chính sách
 * host: rejected → không chạy; unreviewed + gọi tool → cần user
 * xác nhận (trả `needsConfirmation: true`); còn lại → chạy được.
 */
export function checkAppRunPolicy(
  template: DeclaredAppTemplate,
): { allowed: boolean; needsConfirmation: boolean; reason: string } {
  if (template.review === 'rejected') {
    return {
      allowed: false,
      needsConfirmation: false,
      reason: `App "${template.id}" đã bị từ chối review — không chạy.`,
    };
  }
  if (template.review === 'unreviewed' && appActionAllowed(template, 'tool-call')) {
    return {
      allowed: true,
      needsConfirmation: true,
      reason: `App "${template.id}" chưa review mà được gọi tool — cần người dùng xác nhận trước khi chạy.`,
    };
  }
  if (template.review === 'unreviewed') {
    return {
      allowed: true,
      needsConfirmation: true,
      reason: `App "${template.id}" chưa review — cần người dùng xác nhận trước khi chạy.`,
    };
  }
  return {
    allowed: true,
    needsConfirmation: false,
    reason: `App "${template.id}" đã ${template.review} — chạy được.`,
  };
}

/** Validate một declaration thô trước khi declare (dùng cho tool mcp_v2_app_prefetch). */
export function validateAppTemplateDeclaration(input: unknown): AppTemplateDeclaration {
  if (!isRecord(input)) {
    throw new AppCacheManifestError('App template declaration phải là một object.');
  }
  const declaration = input as unknown as AppTemplateDeclaration;
  if (typeof declaration.id !== 'string' || !declaration.id.trim()) {
    throw new AppCacheManifestError('App template declaration thiếu "id".');
  }
  if (typeof declaration.serverName !== 'string' || !declaration.serverName.trim()) {
    throw new AppCacheManifestError('App template declaration thiếu "serverName".');
  }
  if (typeof declaration.title !== 'string' || !declaration.title.trim()) {
    throw new AppCacheManifestError('App template declaration thiếu "title".');
  }
  if (declaration.prefetch !== undefined && !Array.isArray(declaration.prefetch)) {
    throw new AppCacheManifestError('App template declaration: "prefetch" phải là một mảng.');
  }
  if (declaration.allowedActions !== undefined) {
    const allowed: readonly string[] = ['tool-call', 'link-open', 'form-submit', 'resource-read'];
    const actions = declaration.allowedActions as unknown[];
    if (!Array.isArray(actions) || actions.some((a) => !allowed.includes(a as string))) {
      throw new AppCacheManifestError(
        'App template declaration: "allowedActions" chỉ chứa tool-call / link-open / form-submit / resource-read.',
      );
    }
  }
  return declaration;
}

export type { AppUiActionKind, DeclaredAppTemplate };
