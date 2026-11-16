/**
 * MCP Apps v2 — permissions mic/camera cho từng app (v1.14, Đội T2).
 *
 * Spec 2026-07-28: app xin mic/camera qua `_meta.ui.permissions`; host
 * hỏi user theo từng app, ghi nhớ lựa chọn, thu hồi được. Catalogue v112
 * đã có quyền file/network/clipboard/notifications — nhưng CHƯA có
 * mic/camera, và chưa có store ghi nhớ quyết định theo app. Module này
 * là store đó:
 *
 *   - `McpAppPermissionsV2`: quyết định theo cặp (appUri, kind) với 3
 *     trạng thái `granted` | `denied` | `prompt` (chưa hỏi / chưa nhớ).
 *   - `requestPermission()` trả quyết định hiện tại (không tự cấp —
 *     UI hỏi user rồi gọi `setDecision()` với lựa chọn đó).
 *   - `setDecision(..., { remember })`: nhớ thì lưu bền, không nhớ thì
 *     chỉ có hiệu lực trong phiên (session grant).
 *   - `revoke()` thu hồi một quyền hoặc toàn bộ quyền của một app.
 *   - Lưu bền vào `<userDataDir>/mcp-app-permissions-v2.json` (chỉ chứa
 *     quyết định, không chứa dữ liệu mic/camera); load/save chịu lỗi
 *     (file hỏng -> store rỗng, không crash app).
 *   - `permissionsPolicyForApp()` nối sang bundler: chỉ quyền `granted`
 *     mới đưa vào Permissions-Policy header.
 *
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Quyền media app có thể xin. */
export type McpAppMediaPermission = 'microphone' | 'camera';

/** Mọi quyền media app có thể xin. */
export const MCP_APP_V2_MEDIA_PERMISSIONS: readonly McpAppMediaPermission[] = [
  'microphone',
  'camera',
];

/** Quyết định của user cho một quyền của một app. */
export type McpAppPermissionDecision = 'granted' | 'denied' | 'prompt';

/** Một bản ghi quyết định đã lưu. */
export interface McpAppPermissionRecord {
  appUri: string;
  permission: McpAppMediaPermission;
  decision: Exclude<McpAppPermissionDecision, 'prompt'>;
  /** true = đã lưu bền (nhớ lựa chọn); false = chỉ trong phiên. */
  remembered: boolean;
  decidedAtMs: number;
}

export class AppPermissionsV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppPermissionsV2Error';
  }
}

/** Tên file lưu bền quyết định quyền. */
export const MCP_APP_PERMISSIONS_V2_FILE = 'mcp-app-permissions-v2.json';

/** Tối đa số app có quyền đã lưu (chặn file phình vô hạn). */
export const MCP_APP_PERMISSIONS_V2_MAX_RECORDS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidAppUri(uri: string): boolean {
  return uri.startsWith('ui://') && uri.length > 'ui://'.length && uri.length <= 512;
}

function recordKey(appUri: string, permission: McpAppMediaPermission): string {
  return `${appUri}::${permission}`;
}

function validatePermissionRecord(value: unknown): McpAppPermissionRecord | null {
  if (!isRecord(value)) return null;
  const appUri = value['appUri'];
  const permission = value['permission'];
  const decision = value['decision'];
  if (typeof appUri !== 'string' || !isValidAppUri(appUri)) return null;
  if (permission !== 'microphone' && permission !== 'camera') return null;
  if (decision !== 'granted' && decision !== 'denied') return null;
  return {
    appUri,
    permission,
    decision,
    remembered: value['remembered'] === true,
    decidedAtMs: typeof value['decidedAtMs'] === 'number' ? value['decidedAtMs'] : 0,
  };
}

/** Parse `_meta.ui.permissions` tool khai báo (vd `['microphone']`). */
export function parseUiPermissions(value: unknown): McpAppMediaPermission[] {
  if (!Array.isArray(value)) return [];
  const out: McpAppMediaPermission[] = [];
  for (const entry of value) {
    if ((entry === 'microphone' || entry === 'camera') && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/** Đường dẫn file lưu bền trong userDataDir. */
export function getAppPermissionsV2Path(userDataDir: string): string {
  return path.join(userDataDir, MCP_APP_PERMISSIONS_V2_FILE);
}

/**
 * Store quyết định quyền mic/camera theo từng app. Mặc định lưu bền
 * vào userDataDir khi có; không có userDataDir thì chỉ giữ trong RAM.
 */
export class McpAppPermissionsV2 {
  private readonly records = new Map<string, McpAppPermissionRecord>();
  private readonly sessionGrants = new Map<string, McpAppPermissionRecord>();
  private readonly userDataDir?: string;
  private readonly now: () => number;

  constructor(options: { userDataDir?: string; now?: () => number } = {}) {
    this.userDataDir = options.userDataDir;
    this.now = options.now ?? Date.now;
    if (this.userDataDir) this.loadFromDisk();
  }

  /** Số quyết định đã nhớ (lưu bền). */
  get rememberedCount(): number {
    return this.records.size;
  }

  /** Quyết định hiện tại cho (app, quyền): chưa hỏi -> `prompt`. */
  check(appUri: string, permission: McpAppMediaPermission): McpAppPermissionDecision {
    if (!isValidAppUri(appUri)) {
      throw new AppPermissionsV2Error(`Permissions v2: appUri không hợp lệ: "${appUri}"`);
    }
    const key = recordKey(appUri, permission);
    const remembered = this.records.get(key);
    if (remembered) return remembered.decision;
    const session = this.sessionGrants.get(key);
    if (session) return session.decision;
    return 'prompt';
  }

  /**
   * App xin quyền: trả quyết định hiện tại. Khi trả `prompt`, host phải
   * hỏi user (UI) rồi gọi `setDecision()` — store không tự cấp quyền.
   */
  requestPermission(
    appUri: string,
    permission: McpAppMediaPermission,
  ): { appUri: string; permission: McpAppMediaPermission; decision: McpAppPermissionDecision } {
    return { appUri, permission, decision: this.check(appUri, permission) };
  }

  /**
   * Ghi quyết định của user. `remember: true` -> lưu bền (nhớ lựa chọn);
   * `false` -> chỉ có hiệu lực trong phiên, app mở lại sẽ hỏi lại.
   */
  setDecision(
    appUri: string,
    permission: McpAppMediaPermission,
    decision: Exclude<McpAppPermissionDecision, 'prompt'>,
    options: { remember?: boolean } = {},
  ): McpAppPermissionRecord {
    if (!isValidAppUri(appUri)) {
      throw new AppPermissionsV2Error(`Permissions v2: appUri không hợp lệ: "${appUri}"`);
    }
    const record: McpAppPermissionRecord = {
      appUri,
      permission,
      decision,
      remembered: options.remember === true,
      decidedAtMs: this.now(),
    };
    const key = recordKey(appUri, permission);
    if (record.remembered) {
      this.sessionGrants.delete(key);
      this.records.set(key, record);
      this.enforceCap();
      this.saveToDisk();
    } else {
      this.sessionGrants.set(key, record);
    }
    return record;
  }

  /** Thu hồi quyền của một app (một kind, hoặc toàn bộ khi không truyền kind). */
  revoke(appUri: string, permission?: McpAppMediaPermission): number {
    let removed = 0;
    const kinds = permission ? [permission] : [...MCP_APP_V2_MEDIA_PERMISSIONS];
    for (const kind of kinds) {
      const key = recordKey(appUri, kind);
      if (this.records.delete(key)) removed += 1;
      if (this.sessionGrants.delete(key)) removed += 1;
    }
    if (removed > 0) this.saveToDisk();
    return removed;
  }

  /** Toàn bộ quyền (đã nhớ + trong phiên) của một app. */
  permissionsForApp(appUri: string): McpAppPermissionRecord[] {
    const out: McpAppPermissionRecord[] = [];
    for (const record of [...this.records.values(), ...this.sessionGrants.values()]) {
      if (record.appUri === appUri) out.push({ ...record });
    }
    return out.sort((a, b) => a.permission.localeCompare(b.permission));
  }

  /** True khi app được cấp quyền (đã nhớ hoặc trong phiên). */
  isGranted(appUri: string, permission: McpAppMediaPermission): boolean {
    return this.check(appUri, permission) === 'granted';
  }

  /** Quyền media đã cấp của app — để bundler sinh Permissions-Policy. */
  grantedPermissions(appUri: string): McpAppMediaPermission[] {
    return MCP_APP_V2_MEDIA_PERMISSIONS.filter((kind) => this.isGranted(appUri, kind));
  }

  /** Tất cả quyết định đã nhớ (bản sao). */
  listRemembered(): McpAppPermissionRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** Xoá toàn bộ quyết định (đã nhớ + phiên) — dùng khi reset. */
  clearAll(): void {
    this.records.clear();
    this.sessionGrants.clear();
    this.saveToDisk();
  }

  private enforceCap(): void {
    if (this.records.size <= MCP_APP_PERMISSIONS_V2_MAX_RECORDS) return;
    const sorted = [...this.records.values()].sort((a, b) => a.decidedAtMs - b.decidedAtMs);
    const excess = sorted.slice(0, this.records.size - MCP_APP_PERMISSIONS_V2_MAX_RECORDS);
    for (const record of excess) {
      this.records.delete(recordKey(record.appUri, record.permission));
    }
  }

  private loadFromDisk(): void {
    if (!this.userDataDir) return;
    try {
      const raw = fs.readFileSync(getAppPermissionsV2Path(this.userDataDir), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        const record = validatePermissionRecord(entry);
        if (record) this.records.set(recordKey(record.appUri, record.permission), record);
      }
    } catch {
      // File chưa có / hỏng -> store rỗng, không crash app.
    }
  }

  private saveToDisk(): void {
    if (!this.userDataDir) return;
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(
        getAppPermissionsV2Path(this.userDataDir),
        JSON.stringify([...this.records.values()], null, 2),
        'utf8',
      );
    } catch {
      // Ghi bền thất bại -> quyết định vẫn còn trong RAM phiên này.
    }
  }
}

/** Mô tả quyết định bằng tiếng Việt cho UI. */
export function describePermissionDecision(
  permission: McpAppMediaPermission,
  decision: McpAppPermissionDecision,
): string {
  const label = permission === 'microphone' ? 'microphone' : 'camera';
  if (decision === 'granted') return `Đã cho phép dùng ${label}.`;
  if (decision === 'denied') return `Đã từ chối dùng ${label}.`;
  return `Chưa quyết định quyền ${label} — app sẽ hỏi khi cần.`;
}
