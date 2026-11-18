/**
 * Plugin SDK v4 — capability manifest versioned + lifecycle + sandbox
 * quyền plugin (v1.29, Đội T6).
 *
 * Tầng trên của plugin v0.3/v0.14 (`packages/tools/src/plugins/` —
 * manifest v1 `id/name/version/permissions[fs|shell|network|mcp]/main/
 * tools`, load in-process hoặc sandbox fork) và bundle v1.07
 * (`packages/core/src/plugins/bundle.ts` — bundle skill/subagent/MCP/
 * slash). V0.3 trả lời "plugin này có tool gì, cần quyền gì"; v4 trả
 * lời 5 câu tiếp theo:
 *
 * - MANIFEST VERSIONED: manifest v4 có `sdkVersion: 4` + danh sách
 *   `capabilities` có version riêng từng capability (vd
 *   `tools@1`, `fs.read@2`, `network.fetch@1`); SDK kiểm tra tương
 *   thích: plugin yêu cầu SDK <= 4 mới chạy được, capability version
 *   phải nằm trong khoảng host hỗ trợ (major bằng, minor <= host).
 * - CAPABILITY REGISTRY: host khai báo capability nào nó hỗ trợ, ở
 *   version nào, ánh xạ sang quyền hệ thống (fs/shell/network/mcp)
 *   và mức rủi ro (low/medium/high); plugin khai capability không
 *   có trong registry → lỗi rõ ràng, không load lén.
 * - LIFECYCLE: state machine installed → enabled → disabled →
 *   uninstalled, với install (validate manifest + dependency),
 *   enable (chỉ khi dependency đã enabled), disable (cấm disable khi
 *   plugin khác đang phụ thuộc và đang enabled), uninstall (chỉ khi
 *   không còn ai phụ thuộc). Mọi chuyển đổi đều ghi lý do + thời gian
 *   để audit.
 * - DEPENDENCY: plugin khai `dependsOn: [{id, versionRange}]`; resolve
 *   thứ tự load bằng topological sort; thiếu dependency / version
 *   không khớp / chu trình → lỗi liệt kê rõ từng vấn đề.
 * - SANDBOX QUYỀN: policy sandbox tính từ capability + quyền user
 *   duyệt: mỗi capability cho một tập quyền tối đa; user có thể thu
 *   hẹp (vd chỉ cho `fs.read` trong một thư mục); đánh giá một yêu
 *   cầu quyền (capability + operation + target) → allow/deny + lý do;
 *   quyền high-risk (shell, network) mặc định deny trừ khi user duyệt
 *   tường minh.
 *
 * Module này KHÔNG load code plugin, KHÔNG chạy sandbox thật: nó
 * quyết định "manifest này hợp lệ không, plugin này được bật không,
 * quyền này có được cấp không" — việc load/chạy plugin thật do
 * `PluginManager` (tools) và sandbox host làm, dùng các quyết định ở
 * đây.
 */

/** SDK version hiện tại của host. */
export const PLUGIN_SDK_V19_VERSION = 4;
/** SDK version tối thiểu mà host còn hỗ trợ (plugin cũ hơn thì lỗi). */
export const PLUGIN_SDK_V19_MIN_SUPPORTED = 1;
/** SDK version tối đa plugin được khai (cao hơn host thì lỗi). */
export const PLUGIN_SDK_V19_MAX_SUPPORTED = 4;

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/** Mức rủi ro của một capability (để UI tô màu + mặc định deny). */
export type PluginV19Risk = 'low' | 'medium' | 'high';

/** Quyền hệ thống mà capability cần (khớp PLUGIN_PERMISSIONS của tools). */
export type PluginV19SystemPermission = 'fs' | 'shell' | 'network' | 'mcp';

/** Một capability mà host hỗ trợ, có version. */
export interface PluginV19CapabilityDef {
  /** Tên capability, vd `tools`, `fs.read`, `network.fetch`. */
  name: string;
  /** Version major mà host hỗ trợ. */
  major: number;
  /** Version minor cao nhất mà host hỗ trợ. */
  maxMinor: number;
  /** Quyền hệ thống mà capability này cần (rỗng = không cần quyền hệ thống). */
  systemPermissions: PluginV19SystemPermission[];
  risk: PluginV19Risk;
  description: string;
}

/** Một capability mà plugin yêu cầu (có version). */
export interface PluginV19CapabilityReq {
  name: string;
  /** Major yêu cầu (phải bằng major host hỗ trợ). */
  major: number;
  /** Minor tối thiểu yêu cầu (host phải hỗ trợ >= minor này). */
  minor: number;
}

/** Parse `name@major.minor` thành capability req; sai định dạng → null. */
export function parsePluginV19Capability(text: string): PluginV19CapabilityReq | null {
  const match = /^([A-Za-z][A-Za-z0-9._-]*)@(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1], major: Number(match[2]), minor: Number(match[3]) };
}

/** Format capability req thành `name@major.minor`. */
export function formatPluginV19Capability(req: PluginV19CapabilityReq): string {
  return `${req.name}@${req.major}.${req.minor}`;
}

/**
 * Kiểm tra capability req có tương thích với def của host không:
 * tên phải khớp, major phải bằng, minor yêu cầu <= minor host hỗ trợ.
 * Trả '' = tương thích, ngược lại là lý do.
 */
export function checkPluginV19CapabilityCompat(
  req: PluginV19CapabilityReq,
  def: PluginV19CapabilityDef,
): string {
  if (req.name !== def.name) return `capability ${req.name} không có trong registry (host chỉ có ${def.name})`;
  if (req.major !== def.major) {
    return `capability ${req.name} yêu cầu major ${req.major}, host hỗ trợ major ${def.major}`;
  }
  if (req.minor > def.maxMinor) {
    return `capability ${req.name} yêu cầu minor ${req.minor}, host hỗ trợ tối đa ${def.maxMinor}`;
  }
  return '';
}

/** Registry capability của host (do host build từ các def, tra theo tên). */
export type PluginV19CapabilityRegistry = ReadonlyMap<string, PluginV19CapabilityDef>;

/** Build registry từ danh sách def (trùng tên → throw). */
export function buildPluginV19CapabilityRegistry(
  defs: readonly PluginV19CapabilityDef[],
): PluginV19CapabilityRegistry {
  const map = new Map<string, PluginV19CapabilityDef>();
  for (const def of defs) {
    if (map.has(def.name)) throw new Error(`capability trùng tên trong registry: ${def.name}`);
    if (!Number.isInteger(def.major) || def.major < 1) {
      throw new Error(`capability ${def.name} major phải là số nguyên >= 1`);
    }
    if (!Number.isInteger(def.maxMinor) || def.maxMinor < 0) {
      throw new Error(`capability ${def.name} maxMinor phải là số nguyên >= 0`);
    }
    map.set(def.name, def);
  }
  return map;
}

/** Bộ capability mặc định mà host v19 hỗ trợ. */
export function defaultPluginV19Capabilities(): PluginV19CapabilityDef[] {
  return [
    { name: 'tools', major: 1, maxMinor: 2, systemPermissions: [], risk: 'low', description: 'Đóng góp tool cho agent' },
    { name: 'fs.read', major: 2, maxMinor: 1, systemPermissions: ['fs'], risk: 'low', description: 'Đọc file trong thư mục cho phép' },
    { name: 'fs.write', major: 1, maxMinor: 0, systemPermissions: ['fs'], risk: 'medium', description: 'Ghi file trong thư mục cho phép' },
    { name: 'shell.exec', major: 1, maxMinor: 1, systemPermissions: ['shell'], risk: 'high', description: 'Chạy lệnh shell (cần duyệt)' },
    { name: 'network.fetch', major: 1, maxMinor: 3, systemPermissions: ['network'], risk: 'medium', description: 'Gọi HTTP tới host cho phép' },
    { name: 'mcp.client', major: 1, maxMinor: 0, systemPermissions: ['mcp'], risk: 'medium', description: 'Kết nối MCP server đã cấu hình' },
    { name: 'ui.panel', major: 1, maxMinor: 0, systemPermissions: [], risk: 'low', description: 'Thêm panel vào desktop UI' },
    { name: 'hooks', major: 1, maxMinor: 1, systemPermissions: [], risk: 'low', description: 'Đăng ký hook vào agent lifecycle' },
  ];
}

// ---------------------------------------------------------------------------
// Manifest v4
// ---------------------------------------------------------------------------

/** Một dependency của plugin: id + version range dạng `^1.2.0` / `>=1.0.0 <2.0.0` / `1.2.3`. */
export interface PluginV19Dependency {
  id: string;
  versionRange: string;
}

/** Manifest plugin SDK v4. */
export interface PluginV19Manifest {
  id: string;
  name: string;
  version: string;
  sdkVersion: number;
  description: string;
  author: string;
  /** Capability yêu cầu (đã parse; manifest file ghi dạng `name@major.minor`). */
  capabilities: PluginV19CapabilityReq[];
  /** Quyền hệ thống khai thêm (phải khớp với capability đã khai). */
  permissions: PluginV19SystemPermission[];
  main: string;
  /** Tool mà plugin đóng góp (tên tool, để UI liệt kê). */
  tools: string[];
  dependsOn: PluginV19Dependency[];
}

/** Lỗi validate manifest, '' = hợp lệ (chưa kiểm tra registry/dependency). */
export function validatePluginV19Manifest(manifest: PluginV19Manifest): string {
  if (typeof manifest.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(manifest.id)) {
    return 'id phải khớp [A-Za-z0-9_-]+';
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return 'name không được rỗng';
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    return 'version phải dạng semver x.y.z';
  }
  if (!Number.isInteger(manifest.sdkVersion) || manifest.sdkVersion < PLUGIN_SDK_V19_MIN_SUPPORTED || manifest.sdkVersion > PLUGIN_SDK_V19_MAX_SUPPORTED) {
    return `sdkVersion phải trong ${PLUGIN_SDK_V19_MIN_SUPPORTED}..${PLUGIN_SDK_V19_MAX_SUPPORTED}`;
  }
  if (typeof manifest.main !== 'string' || manifest.main.length === 0) return 'main không được rỗng';
  if (manifest.main.startsWith('/') || manifest.main.includes('..')) {
    return 'main không được là đường dẫn tuyệt đối hoặc chứa ..';
  }
  const seen = new Set<string>();
  for (const cap of manifest.capabilities) {
    if (typeof cap.name !== 'string' || cap.name.length === 0) return 'capability name không được rỗng';
    if (!Number.isInteger(cap.major) || cap.major < 1) return `capability ${cap.name} major không hợp lệ`;
    if (!Number.isInteger(cap.minor) || cap.minor < 0) return `capability ${cap.name} minor không hợp lệ`;
    if (seen.has(cap.name)) return `capability trùng: ${cap.name}`;
    seen.add(cap.name);
  }
  const validPerms: readonly string[] = ['fs', 'shell', 'network', 'mcp'];
  for (const p of manifest.permissions) {
    if (!validPerms.includes(p)) return `permission không hợp lệ: ${p}`;
  }
  const toolSeen = new Set<string>();
  for (const t of manifest.tools) {
    if (typeof t !== 'string' || t.length === 0) return 'tool name không được rỗng';
    if (toolSeen.has(t)) return `tool trùng: ${t}`;
    toolSeen.add(t);
  }
  const depSeen = new Set<string>();
  for (const d of manifest.dependsOn) {
    if (typeof d.id !== 'string' || d.id.length === 0) return 'dependency id không được rỗng';
    if (d.id === manifest.id) return 'plugin không được phụ thuộc chính nó';
    if (typeof d.versionRange !== 'string' || d.versionRange.length === 0) {
      return `dependency ${d.id} versionRange không được rỗng`;
    }
    if (depSeen.has(d.id)) return `dependency trùng: ${d.id}`;
    depSeen.add(d.id);
  }
  return '';
}

/**
 * Kiểm tra manifest với capability registry: mọi capability yêu cầu
 * phải có trong registry + tương thích version; mọi permission hệ
 * thống phải được ít nhất một capability đã khai bao phủ. Trả danh
 * sách lỗi (rỗng = hợp lệ).
 */
export function checkPluginV19ManifestAgainstRegistry(
  manifest: PluginV19Manifest,
  registry: PluginV19CapabilityRegistry,
): string[] {
  const errors: string[] = [];
  const covered = new Set<PluginV19SystemPermission>();
  for (const req of manifest.capabilities) {
    const def = registry.get(req.name);
    if (!def) {
      errors.push(`capability ${req.name} không có trong registry của host`);
      continue;
    }
    const compat = checkPluginV19CapabilityCompat(req, def);
    if (compat !== '') errors.push(compat);
    else for (const p of def.systemPermissions) covered.add(p);
  }
  for (const p of manifest.permissions) {
    if (!covered.has(p)) {
      errors.push(`permission ${p} không được capability nào đã khai bao phủ`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Version range (đơn giản, đủ cho plugin: ^x.y.z, >=a <b, x.y.z)
// ---------------------------------------------------------------------------

/** Parse `x.y.z` thành [x, y, z]; sai → null. */
export function parsePluginV19Version(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** So sánh 2 version đã parse: -1/0/1. */
export function comparePluginV19Versions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * true = version thỏa versionRange. Hỗ trợ:
 * - `1.2.3` (khớp chính xác), `^1.2.3` (>=1.2.3 <2.0.0),
 *   `~1.2.3` (>=1.2.3 <1.3.0), `>=1.0.0` / `>1.0.0` / `<=2.0.0` /
 *   `<2.0.0` (một điều kiện), `>=1.0.0 <2.0.0` (hai điều kiện AND).
 * Range không parse được → false (an toàn: không cài plugin mà
 * range mơ hồ).
 */
export function pluginV19VersionSatisfies(version: string, range: string): boolean {
  const v = parsePluginV19Version(version);
  if (v === null) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    let m: RegExpExecArray | null;
    if ((m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(part)) !== null) {
      const base: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (comparePluginV19Versions(v, base) < 0) return false;
      if (v[0] !== base[0]) return false;
    } else if ((m = /^~(\d+)\.(\d+)\.(\d+)$/.exec(part)) !== null) {
      const base: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (comparePluginV19Versions(v, base) < 0) return false;
      if (v[0] !== base[0] || v[1] !== base[1]) return false;
    } else if ((m = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(part)) !== null) {
      const op = m[1] ?? '=';
      const base: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
      const cmp = comparePluginV19Versions(v, base);
      if (op === '=' && cmp !== 0) return false;
      if (op === '>=' && cmp < 0) return false;
      if (op === '<=' && cmp > 0) return false;
      if (op === '>' && cmp <= 0) return false;
      if (op === '<' && cmp >= 0) return false;
    } else {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Trạng thái vòng đời của một plugin đã cài. */
export type PluginV19Lifecycle = 'installed' | 'enabled' | 'disabled' | 'uninstalled';

export const PLUGIN_V19_LIFECYCLES: readonly PluginV19Lifecycle[] = [
  'installed',
  'enabled',
  'disabled',
  'uninstalled',
];

/** Một plugin đã cài (manifest + trạng thái + lịch sử chuyển đổi). */
export interface PluginV19Installed {
  manifest: PluginV19Manifest;
  lifecycle: PluginV19Lifecycle;
  installedAt: number;
  /** Lần chuyển trạng thái gần nhất (epoch ms). */
  updatedAt: number;
  /** Lý do chuyển trạng thái gần nhất (vd ai disable, vì sao). */
  lastReason: string;
  /** Quyền high-risk mà user đã duyệt tường minh (vd ['shell']). */
  approvedPermissions: PluginV19SystemPermission[];
  /** Giới hạn sandbox do user đặt (vd thư mục fs cho phép). */
  sandboxLimits: PluginV19SandboxLimits;
}

/** Giới hạn sandbox do user đặt cho một plugin. */
export interface PluginV19SandboxLimits {
  /** Thư mục fs được phép (rỗng = không giới hạn thư mục, vẫn cần quyền fs). */
  allowedDirs: string[];
  /** Host network được phép (rỗng = không giới hạn host, vẫn cần quyền network). */
  allowedHosts: string[];
  /** Lệnh shell được phép, dạng prefix (rỗng = cấm shell dù đã duyệt). */
  allowedShellPrefixes: string[];
}

/** Giới hạn sandbox mặc định: không giới hạn thêm (chỉ dùng quyền đã duyệt). */
export function defaultPluginV19SandboxLimits(): PluginV19SandboxLimits {
  return { allowedDirs: [], allowedHosts: [], allowedShellPrefixes: [] };
}

/** Store plugin đã cài: id -> plugin. */
export type PluginV19Store = ReadonlyMap<string, PluginV19Installed>;

/** Tạo một bản ghi installed từ manifest đã validate (trạng thái installed). */
export function installPluginV19(
  store: PluginV19Store,
  manifest: PluginV19Manifest,
  registry: PluginV19CapabilityRegistry,
  at: number,
): { store: Map<string, PluginV19Installed>; plugin: PluginV19Installed } {
  const err = validatePluginV19Manifest(manifest);
  if (err !== '') throw new Error(`manifest không hợp lệ: ${err}`);
  const registryErrors = checkPluginV19ManifestAgainstRegistry(manifest, registry);
  if (registryErrors.length > 0) {
    throw new Error(`manifest không khớp registry: ${registryErrors.join('; ')}`);
  }
  if (store.has(manifest.id)) {
    throw new Error(`plugin đã cài: ${manifest.id}`);
  }
  const next = new Map(store);
  const plugin: PluginV19Installed = {
    manifest,
    lifecycle: 'installed',
    installedAt: at,
    updatedAt: at,
    lastReason: 'installed',
    approvedPermissions: [],
    sandboxLimits: defaultPluginV19SandboxLimits(),
  };
  next.set(manifest.id, plugin);
  return { store: next, plugin };
}

/** Kiểm tra dependency của plugin: thiếu / version không khớp / chu trình. */
export function checkPluginV19Dependencies(
  store: PluginV19Store,
  pluginId: string,
): string[] {
  const errors: string[] = [];
  const plugin = store.get(pluginId);
  if (!plugin) return [`plugin chưa cài: ${pluginId}`];
  const visiting = new Set<string>([pluginId]);
  const visit = (id: string, chain: string[]): void => {
    const current = store.get(id);
    if (!current) return;
    for (const dep of current.manifest.dependsOn) {
      const target = store.get(dep.id);
      if (!target) {
        errors.push(`thiếu dependency ${dep.id} (${dep.versionRange}) cho ${id}`);
        continue;
      }
      if (!pluginV19VersionSatisfies(target.manifest.version, dep.versionRange)) {
        errors.push(
          `dependency ${dep.id} version ${target.manifest.version} không thỏa ${dep.versionRange} (cho ${id})`,
        );
      }
      if (visiting.has(dep.id)) {
        errors.push(`chu trình dependency: ${[...chain, id, dep.id].join(' -> ')}`);
        continue;
      }
      visiting.add(dep.id);
      visit(dep.id, [...chain, id]);
      visiting.delete(dep.id);
    }
  };
  visit(pluginId, []);
  return errors;
}

/**
 * Enable một plugin (installed/disabled -> enabled):
 * - plugin phải đã cài và chưa enabled;
 * - dependency phải đầy đủ + version khớp (không chu trình);
 * - mọi dependency phải đang enabled (không enable plugin khi dep còn tắt).
 * Trả store mới; lỗi → throw kèm lý do.
 */
export function enablePluginV19(
  store: PluginV19Store,
  pluginId: string,
  at: number,
  reason = '',
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  if (plugin.lifecycle === 'enabled') throw new Error(`plugin đã enabled: ${pluginId}`);
  if (plugin.lifecycle === 'uninstalled') throw new Error(`plugin đã gỡ: ${pluginId}`);
  const depErrors = checkPluginV19Dependencies(store, pluginId);
  if (depErrors.length > 0) throw new Error(`không enable được ${pluginId}: ${depErrors.join('; ')}`);
  for (const dep of plugin.manifest.dependsOn) {
    const target = store.get(dep.id);
    if (target && target.lifecycle !== 'enabled') {
      throw new Error(`không enable được ${pluginId}: dependency ${dep.id} chưa enabled (đang ${target.lifecycle})`);
    }
  }
  const next = new Map(store);
  next.set(pluginId, { ...plugin, lifecycle: 'enabled', updatedAt: at, lastReason: reason || 'enabled' });
  return next;
}

/**
 * Disable một plugin đang enabled (enabled -> disabled):
 * - cấm disable khi có plugin khác đang enabled và phụ thuộc vào nó
 *   (phải disable plugin con trước).
 */
export function disablePluginV19(
  store: PluginV19Store,
  pluginId: string,
  at: number,
  reason = '',
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  if (plugin.lifecycle !== 'enabled') throw new Error(`plugin không ở trạng thái enabled: ${pluginId} (đang ${plugin.lifecycle})`);
  for (const [id, other] of store) {
    if (id === pluginId || other.lifecycle !== 'enabled') continue;
    if (other.manifest.dependsOn.some((d) => d.id === pluginId)) {
      throw new Error(`không disable được ${pluginId}: plugin ${id} đang enabled và phụ thuộc vào nó`);
    }
  }
  const next = new Map(store);
  next.set(pluginId, { ...plugin, lifecycle: 'disabled', updatedAt: at, lastReason: reason || 'disabled' });
  return next;
}

/**
 * Uninstall một plugin (installed/disabled -> uninstalled):
 * - cấm gỡ khi còn plugin khác (bất kể trạng thái nào trừ uninstalled)
 *   phụ thuộc vào nó;
 * - plugin đang enabled phải disable trước.
 */
export function uninstallPluginV19(
  store: PluginV19Store,
  pluginId: string,
  at: number,
  reason = '',
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  if (plugin.lifecycle === 'enabled') {
    throw new Error(`không gỡ được ${pluginId}: plugin đang enabled — disable trước`);
  }
  if (plugin.lifecycle === 'uninstalled') throw new Error(`plugin đã gỡ: ${pluginId}`);
  for (const [id, other] of store) {
    if (id === pluginId || other.lifecycle === 'uninstalled') continue;
    if (other.manifest.dependsOn.some((d) => d.id === pluginId)) {
      throw new Error(`không gỡ được ${pluginId}: plugin ${id} còn phụ thuộc vào nó`);
    }
  }
  const next = new Map(store);
  next.set(pluginId, { ...plugin, lifecycle: 'uninstalled', updatedAt: at, lastReason: reason || 'uninstalled' });
  return next;
}

/** Duyệt thêm một quyền high-risk cho plugin (user bấm approve trong UI). */
export function approvePluginV19Permission(
  store: PluginV19Store,
  pluginId: string,
  permission: PluginV19SystemPermission,
  at: number,
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  if (!plugin.manifest.permissions.includes(permission)) {
    throw new Error(`plugin ${pluginId} không khai permission ${permission}, không duyệt được`);
  }
  if (plugin.approvedPermissions.includes(permission)) return new Map(store);
  const next = new Map(store);
  next.set(pluginId, {
    ...plugin,
    approvedPermissions: [...plugin.approvedPermissions, permission],
    updatedAt: at,
    lastReason: `approved ${permission}`,
  });
  return next;
}

/** Thu hồi một quyền đã duyệt. */
export function revokePluginV19Permission(
  store: PluginV19Store,
  pluginId: string,
  permission: PluginV19SystemPermission,
  at: number,
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  if (!plugin.approvedPermissions.includes(permission)) return new Map(store);
  const next = new Map(store);
  next.set(pluginId, {
    ...plugin,
    approvedPermissions: plugin.approvedPermissions.filter((p) => p !== permission),
    updatedAt: at,
    lastReason: `revoked ${permission}`,
  });
  return next;
}

/** Đặt giới hạn sandbox cho plugin (user thu hẹp quyền trong UI). */
export function setPluginV19SandboxLimits(
  store: PluginV19Store,
  pluginId: string,
  limits: PluginV19SandboxLimits,
  at: number,
): Map<string, PluginV19Installed> {
  const plugin = store.get(pluginId);
  if (!plugin) throw new Error(`plugin chưa cài: ${pluginId}`);
  const next = new Map(store);
  next.set(pluginId, { ...plugin, sandboxLimits: { ...limits }, updatedAt: at, lastReason: 'sandbox limits updated' });
  return next;
}

// ---------------------------------------------------------------------------
// Thứ tự load (topological sort theo dependency)
// ---------------------------------------------------------------------------

/**
 * Tính thứ tự load các plugin enabled (dependency trước, plugin sau):
 * - chỉ tính plugin enabled;
 * - thiếu dependency/không khớp version/chu trình → throw liệt kê lỗi.
 * Trả danh sách id theo thứ tự load.
 */
export function resolvePluginV19LoadOrder(store: PluginV19Store): string[] {
  const enabled = [...store.values()].filter((p) => p.lifecycle === 'enabled');
  const errors: string[] = [];
  for (const plugin of enabled) {
    for (const err of checkPluginV19Dependencies(store, plugin.manifest.id)) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw new Error(`không resolve được thứ tự load: ${errors.join('; ')}`);
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`chu trình dependency tại ${id}`);
    const plugin = store.get(id);
    if (!plugin || plugin.lifecycle !== 'enabled') return;
    visiting.add(id);
    for (const dep of plugin.manifest.dependsOn) visit(dep.id);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const plugin of enabled) visit(plugin.manifest.id);
  return order;
}

// ---------------------------------------------------------------------------
// Sandbox quyền — đánh giá yêu cầu quyền lúc chạy
// ---------------------------------------------------------------------------

/** Một yêu cầu quyền lúc plugin chạy. */
export interface PluginV19PermissionRequest {
  pluginId: string;
  capability: string;
  /** Hành động cụ thể, vd `read`, `write`, `exec`, `fetch`. */
  operation: string;
  /** Mục tiêu: đường dẫn file / host / lệnh ('' = không có mục tiêu cụ thể). */
  target: string;
}

/** Kết quả đánh giá quyền: allow/deny + lý do (để UI/audit ghi lại). */
export interface PluginV19PermissionDecision {
  allowed: boolean;
  reason: string;
}

/** Risk của capability: high-risk cần user duyệt tường minh. */
function riskOfCapability(
  registry: PluginV19CapabilityRegistry,
  capability: string,
): PluginV19Risk | null {
  const def = registry.get(capability);
  return def === undefined ? null : def.risk;
}

/** Capability nào cần quyền hệ thống nào (để map operation → permission). */
function systemPermissionForOperation(
  registry: PluginV19CapabilityRegistry,
  capability: string,
): PluginV19SystemPermission | null {
  const def = registry.get(capability);
  if (!def || def.systemPermissions.length === 0) return null;
  return def.systemPermissions[0];
}

/**
 * Đánh giá một yêu cầu quyền của plugin đang enabled:
 * 1. plugin phải tồn tại + enabled;
 * 2. capability phải có trong manifest của plugin;
 * 3. capability phải có trong registry (không thì deny);
 * 4. quyền hệ thống tương ứng phải nằm trong manifest.permissions;
 * 5. quyền high-risk (shell/network) phải được user duyệt tường minh;
 * 6. sandbox limits: fs.read/write phải nằm trong allowedDirs (nếu có
 *    giới hạn), network.fetch phải đúng allowedHosts (nếu có), shell
 *    phải khớp allowedShellPrefixes (nếu không có prefix nào → deny).
 * Trả allow/deny + lý do cụ thể.
 */
export function evaluatePluginV19Permission(
  store: PluginV19Store,
  registry: PluginV19CapabilityRegistry,
  request: PluginV19PermissionRequest,
): PluginV19PermissionDecision {
  const plugin = store.get(request.pluginId);
  if (!plugin) return { allowed: false, reason: `plugin chưa cài: ${request.pluginId}` };
  if (plugin.lifecycle !== 'enabled') {
    return { allowed: false, reason: `plugin ${request.pluginId} không enabled (đang ${plugin.lifecycle})` };
  }
  const req = plugin.manifest.capabilities.find((c) => c.name === request.capability);
  if (!req) {
    return { allowed: false, reason: `plugin không khai capability ${request.capability}` };
  }
  const def = registry.get(request.capability);
  if (!def) {
    return { allowed: false, reason: `capability ${request.capability} không có trong registry` };
  }
  const compat = checkPluginV19CapabilityCompat(req, def);
  if (compat !== '') return { allowed: false, reason: compat };
  const systemPerm = systemPermissionForOperation(registry, request.capability);
  if (systemPerm !== null) {
    if (!plugin.manifest.permissions.includes(systemPerm)) {
      return { allowed: false, reason: `plugin không khai permission ${systemPerm}` };
    }
    const risk = riskOfCapability(registry, request.capability);
    if (risk === 'high' && !plugin.approvedPermissions.includes(systemPerm)) {
      return { allowed: false, reason: `quyền ${systemPerm} rủi ro cao, cần user duyệt trước` };
    }
    if (systemPerm === 'network' && !plugin.approvedPermissions.includes('network')) {
      return { allowed: false, reason: 'quyền network cần user duyệt trước' };
    }
    const limits = plugin.sandboxLimits;
    if (systemPerm === 'fs' && limits.allowedDirs.length > 0) {
      const inside = limits.allowedDirs.some(
        (dir) => request.target === dir || request.target.startsWith(`${dir}/`),
      );
      if (!inside) {
        return { allowed: false, reason: `file ${request.target} ngoài thư mục cho phép` };
      }
    }
    if (systemPerm === 'network' && limits.allowedHosts.length > 0) {
      if (!limits.allowedHosts.includes(request.target)) {
        return { allowed: false, reason: `host ${request.target} ngoài danh sách cho phép` };
      }
    }
    if (systemPerm === 'shell') {
      if (limits.allowedShellPrefixes.length === 0) {
        return { allowed: false, reason: 'shell bị chặn: chưa đặt prefix lệnh cho phép' };
      }
      const ok = limits.allowedShellPrefixes.some((prefix) =>
        request.target === prefix || request.target.startsWith(`${prefix} `) || request.target.startsWith(prefix),
      );
      if (!ok) {
        return { allowed: false, reason: `lệnh ${request.target} không khớp prefix cho phép` };
      }
    }
  }
  return { allowed: true, reason: 'allowed' };
}

/** Tóm tắt store plugin: số lượng theo lifecycle + số plugin có quyền high-risk đã duyệt. */
export function summarizePluginV19Store(store: PluginV19Store): {
  total: number;
  byLifecycle: Record<PluginV19Lifecycle, number>;
  enabledWithHighRiskApproved: number;
} {
  const byLifecycle: Record<PluginV19Lifecycle, number> = {
    installed: 0,
    enabled: 0,
    disabled: 0,
    uninstalled: 0,
  };
  let enabledWithHighRiskApproved = 0;
  for (const plugin of store.values()) {
    byLifecycle[plugin.lifecycle]++;
    if (
      plugin.lifecycle === 'enabled' &&
      plugin.approvedPermissions.some((p) => p === 'shell' || p === 'network')
    ) {
      enabledWithHighRiskApproved++;
    }
  }
  return { total: store.size, byLifecycle, enabledWithHighRiskApproved };
}
