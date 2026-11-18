/**
 * Plugin SDK v4 — tools-side bridge (v1.29, Đội T6).
 *
 * Cầu nối giữa manifest v4 của core (`packages/core/src/fleetV19/
 * pluginSdkV19.ts` — capability versioned, lifecycle, sandbox) và
 * loader v1/v3 của tools (`plugins/loader.ts` — `PluginManifest`,
 * `validateManifest`, load in-process/sandbox). Vì tools không được
 * import trực tiếp source của core (ranh giới package), module này
 * làm việc trên JSON thuần — cùng một object manifest JSON có thể
 * đưa qua cả core (validate đầy đủ) lẫn tools (parse + convert) mà
 * không cần import chéo; test của đội kiểm chứng hai phía khớp nhau
 * trên cùng manifest mẫu.
 *
 * - PARSE: `parsePluginSdkV4ManifestJson` đọc manifest v4 từ JSON
 *   thô (vd file `manifest.json` của plugin): kiểm tra id, semver,
 *   sdkVersion 1..4, capability dạng `name@major.minor`, permission
 *   thuộc fs/shell/network/mcp, main không phải đường dẫn tuyệt đối
 *   hay chứa `..`, dependency có versionRange; trả manifest đã parse
 *   + danh sách lỗi (rỗng = hợp lệ).
 * - CONVERT: `pluginSdkV4ManifestToV3` chuyển manifest v4 thành
 *   `PluginManifest` v1/v3 để `PluginManager`/`loadPlugin` hiện có
 *   load được plugin v4 mà không sửa loader: permissions giữ nguyên,
 *   tools giữ nguyên, `sdkVersion` + `capabilities` được giữ trong
 *   field mở rộng `v4` (loader v1 bỏ qua field lạ — xem loader.ts).
 * - CAPABILITY CHECK: `checkPluginSdkV4Capabilities` kiểm tra mọi
 *   capability yêu cầu có nằm trong danh sách host hỗ trợ không
 *   (caller truyền tên capability từ registry của core, vd
 *   `defaultPluginV19Capabilities().map(c => c.name)`); capability
 *   lạ → lỗi rõ ràng, không load lén.
 * - SANDBOX SUMMARY: `summarizePluginSdkV4Sandbox` tóm tắt quyền
 *   sandbox của plugin (capability high-risk nào cần duyệt, giới
 *   hạn nào đang đặt) để UI plugin store hiển thị trước khi user
 *   bấm Enable.
 *
 * Module này KHÔNG load code plugin, KHÔNG quyết định lifecycle
 * (lifecycle ở core): nó chỉ parse/convert để plugin v4 đi qua được
 * loader hiện có.
 */

import type { PluginManifest, PluginPermission } from './types';
import { PLUGIN_PERMISSIONS } from './types';

/** SDK version mà tools-side bridge hỗ trợ (khớp core PLUGIN_SDK_V19_*). */
export const PLUGIN_SDK_V4_VERSION = 4;
export const PLUGIN_SDK_V4_MIN_SUPPORTED = 1;

/** Một capability yêu cầu trong manifest v4 (dạng đã parse). */
export interface PluginSdkV4CapabilityReq {
  name: string;
  major: number;
  minor: number;
}

/** Một dependency trong manifest v4. */
export interface PluginSdkV4Dependency {
  id: string;
  versionRange: string;
}

/** Manifest plugin SDK v4 — dạng tools-side (JSON-able, khớp core). */
export interface PluginSdkV4Manifest {
  id: string;
  name: string;
  version: string;
  sdkVersion: number;
  description: string;
  author: string;
  capabilities: PluginSdkV4CapabilityReq[];
  permissions: PluginPermission[];
  main: string;
  tools: string[];
  dependsOn: PluginSdkV4Dependency[];
}

/** Giới hạn sandbox của plugin (khớp core PluginV19SandboxLimits). */
export interface PluginSdkV4SandboxLimits {
  allowedDirs: string[];
  allowedHosts: string[];
  allowedShellPrefixes: string[];
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CAPABILITY_RE = /^([A-Za-z][A-Za-z0-9._-]*)@(\d+)\.(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((v) => typeof v !== 'string')) return null;
  return [...(value as string[])];
}

/**
 * Parse manifest v4 từ JSON thô. Trả `{ manifest, errors }`:
 * - hợp lệ: manifest đầy đủ, errors rỗng;
 * - không hợp lệ: manifest null, errors liệt kê từng lỗi (không throw
 *   để caller gom lỗi từ nhiều plugin khi scan thư mục).
 */
export function parsePluginSdkV4ManifestJson(
  raw: unknown,
): { manifest: PluginSdkV4Manifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { manifest: null, errors: ['manifest phải là một JSON object'] };
  const id = raw['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    errors.push('id phải khớp [A-Za-z0-9_-]+');
  }
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) errors.push('name không được rỗng');
  const version = raw['version'];
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    errors.push('version phải dạng semver x.y.z');
  }
  const sdkVersion = raw['sdkVersion'];
  if (
    typeof sdkVersion !== 'number' ||
    !Number.isInteger(sdkVersion) ||
    sdkVersion < PLUGIN_SDK_V4_MIN_SUPPORTED ||
    sdkVersion > PLUGIN_SDK_V4_VERSION
  ) {
    errors.push(`sdkVersion phải trong ${PLUGIN_SDK_V4_MIN_SUPPORTED}..${PLUGIN_SDK_V4_VERSION}`);
  }
  const description = raw['description'];
  if (typeof description !== 'string' || description.length === 0) {
    errors.push('description không được rỗng');
  }
  const author = raw['author'];
  if (author !== undefined && typeof author !== 'string') {
    errors.push('author phải là string khi có');
  }
  const capabilities: PluginSdkV4CapabilityReq[] = [];
  const capRaw = raw['capabilities'];
  if (!Array.isArray(capRaw)) {
    errors.push('capabilities phải là mảng dạng ["name@major.minor", ...]');
  } else {
    const seen = new Set<string>();
    for (const entry of capRaw) {
      if (typeof entry !== 'string') {
        errors.push('capability phải là string dạng "name@major.minor"');
        continue;
      }
      const m = CAPABILITY_RE.exec(entry.trim());
      if (!m) {
        errors.push(`capability sai định dạng: ${entry}`);
        continue;
      }
      if (seen.has(m[1])) errors.push(`capability trùng: ${m[1]}`);
      seen.add(m[1]);
      capabilities.push({ name: m[1], major: Number(m[2]), minor: Number(m[3]) });
    }
  }
  const permissions: PluginPermission[] = [];
  const permRaw = raw['permissions'];
  if (!Array.isArray(permRaw)) {
    errors.push('permissions phải là mảng');
  } else {
    for (const p of permRaw) {
      if (typeof p !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
        errors.push(`permission không hợp lệ: ${String(p)}`);
      } else {
        permissions.push(p as PluginPermission);
      }
    }
  }
  const main = raw['main'];
  if (typeof main !== 'string' || main.length === 0) {
    errors.push('main không được rỗng');
  } else if (main.startsWith('/') || main.includes('..')) {
    errors.push('main không được là đường dẫn tuyệt đối hoặc chứa ..');
  }
  const tools = stringArray(raw['tools'] ?? []);
  if (tools === null) errors.push('tools phải là mảng string');
  const dependsOn: PluginSdkV4Dependency[] = [];
  const depRaw = raw['dependsOn'] ?? [];
  if (!Array.isArray(depRaw)) {
    errors.push('dependsOn phải là mảng');
  } else {
    const depSeen = new Set<string>();
    for (const entry of depRaw) {
      if (!isRecord(entry)) {
        errors.push('dependency phải là object {id, versionRange}');
        continue;
      }
      if (typeof entry['id'] !== 'string' || (entry['id'] as string).length === 0) {
        errors.push('dependency id không được rỗng');
        continue;
      }
      if (typeof entry['versionRange'] !== 'string' || (entry['versionRange'] as string).length === 0) {
        errors.push(`dependency ${entry['id']} versionRange không được rỗng`);
        continue;
      }
      if (depSeen.has(entry['id'] as string)) errors.push(`dependency trùng: ${entry['id']}`);
      depSeen.add(entry['id'] as string);
      dependsOn.push({ id: entry['id'] as string, versionRange: entry['versionRange'] as string });
    }
  }
  if (errors.length > 0) return { manifest: null, errors };
  return {
    manifest: {
      id: id as string,
      name: name as string,
      version: version as string,
      sdkVersion: sdkVersion as number,
      description: description as string,
      author: typeof author === 'string' ? author : '',
      capabilities,
      permissions,
      main: main as string,
      tools: tools ?? [],
      dependsOn,
    },
    errors: [],
  };
}

/**
 * Kiểm tra capability yêu cầu có nằm trong danh sách host hỗ trợ
 * không (caller truyền tên từ registry core). Trả danh sách lỗi
 * (rỗng = mọi capability đều được host hỗ trợ).
 */
export function checkPluginSdkV4Capabilities(
  manifest: PluginSdkV4Manifest,
  supportedCapabilityNames: readonly string[],
): string[] {
  const supported = new Set(supportedCapabilityNames);
  const errors: string[] = [];
  for (const cap of manifest.capabilities) {
    if (!supported.has(cap.name)) {
      errors.push(`capability ${cap.name} không được host hỗ trợ`);
    }
  }
  return errors;
}

/**
 * Chuyển manifest v4 thành manifest v1/v3 cho loader hiện có.
 * `PluginManifest` v1 không có field sdkVersion/capabilities nên hai
 * field này được giữ trong `v4` (loader v1 bỏ qua field lạ — tương
 * thích ngược; xem loader.ts `validateManifest`).
 */
export function pluginSdkV4ManifestToV3(
  manifest: PluginSdkV4Manifest,
): PluginManifest & { v4: { sdkVersion: number; capabilities: string[] } } {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author === '' ? undefined : manifest.author,
    permissions: [...manifest.permissions],
    main: manifest.main,
    tools: manifest.tools.length > 0 ? [...manifest.tools] : undefined,
    v4: {
      sdkVersion: manifest.sdkVersion,
      capabilities: manifest.capabilities.map((c) => `${c.name}@${c.major}.${c.minor}`),
    },
  };
}

/** Tóm tắt sandbox của một plugin v4 (để UI hiển thị trước khi Enable). */
export interface PluginSdkV4SandboxSummary {
  pluginId: string;
  /** Capability nào của plugin cần quyền hệ thống (tên capability). */
  capabilityNames: string[];
  /** Quyền hệ thống plugin khai. */
  permissions: PluginPermission[];
  /** Quyền cần user duyệt tường minh (shell/network — theo core). */
  needsApproval: PluginPermission[];
  /** Quyền đã duyệt (caller truyền từ store core). */
  approvedPermissions: PluginPermission[];
  /** Quyền khai nhưng chưa duyệt. */
  unapprovedPermissions: PluginPermission[];
  /** Giới hạn sandbox đang đặt (rỗng = chưa giới hạn thêm). */
  limits: PluginSdkV4SandboxLimits;
  /** true = plugin được phép chạy (mọi quyền cần duyệt đã duyệt). */
  readyToRun: boolean;
}

/**
 * Tóm tắt sandbox: needsApproval = shell/network trong permissions;
 * readyToRun = mọi quyền needsApproval đã nằm trong approvedPermissions.
 * `limits` do caller truyền (từ store core, hoặc mặc định rỗng).
 */
export function summarizePluginSdkV4Sandbox(
  manifest: PluginSdkV4Manifest,
  approvedPermissions: readonly PluginPermission[],
  limits: PluginSdkV4SandboxLimits = { allowedDirs: [], allowedHosts: [], allowedShellPrefixes: [] },
): PluginSdkV4SandboxSummary {
  const needsApproval = manifest.permissions.filter((p) => p === 'shell' || p === 'network');
  const approved = [...approvedPermissions];
  const unapprovedPermissions = manifest.permissions.filter((p) => !approved.includes(p));
  return {
    pluginId: manifest.id,
    capabilityNames: manifest.capabilities.map((c) => c.name),
    permissions: [...manifest.permissions],
    needsApproval,
    approvedPermissions: approved,
    unapprovedPermissions,
    limits: {
      allowedDirs: [...limits.allowedDirs],
      allowedHosts: [...limits.allowedHosts],
      allowedShellPrefixes: [...limits.allowedShellPrefixes],
    },
    readyToRun: needsApproval.every((p) => approved.includes(p)),
  };
}

/** true = manifest v4 có khai capability high-risk shell (cần duyệt + prefix). */
export function pluginSdkV4NeedsShellApproval(manifest: PluginSdkV4Manifest): boolean {
  return manifest.permissions.includes('shell');
}
