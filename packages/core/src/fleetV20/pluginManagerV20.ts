/**
 * Quản lý plugin v20 — lifecycle install/enable/disable/uninstall
 * (v1.33, Đội T6).
 *
 * Tầng trạng thái thuần cho panel Plugin v20. Nối vào hệ plugin hiện có
 * trong repo thay vì viết song song: `plugins/catalog.ts` đã có
 * scan/parse manifest + review quyền (`PluginCatalogEntry`,
 * `reviewPluginPermissions`, `summarizePluginRisk`) và
 * `fleetV19/pluginSdkV19.ts` đã có manifest versioned + lifecycle v19;
 * module này không parse lại manifest, không thay thế 2 tầng đó — nó
 * trả lời câu panel cần mà 2 tầng đó chưa trả lời:
 *
 * - PLUGIN ĐANG Ở TRẠNG THÁI NÀO, ĐƯỢC LÀM GÌ TIẾP: state machine
 *   rõ ràng available → installed → enabled ⇄ disabled → uninstalled,
 *   kèm `pluginV20AllowedActions` (chỉ hiện nút được phép bấm — panel
 *   không tự đoán).
 * - CÀI CÓ AN TOÀN KHÔNG: check tương thích version host + quyền yêu
 *   cầu (quyền nguy hiểm chưa duyệt thì cài xong vẫn ở trạng thái
 *   `installed` chứ không tự enable), dependency còn thiếu thì báo
 *   rõ tên + version cần.
 * - TÌM NHANH: search theo tên/mô tả/capability + lọc theo trạng thái
 *   / quyền nguy hiểm / lỗi dependency — panel có hàng trăm plugin vẫn
 *   tìm được trong một gõ.
 *
 * Mọi hàm đều pure (nhận state, trả state mới + lỗi) — không đọc disk,
 * không chạm mạng. Host (IPC/main) giữ `PluginV20Store` bền vững,
 * gọi `scanInstalledPlugins` khi cần đồng bộ với disk thật.
 */

export type PluginV20Status =
  | 'available'
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'error'
  | 'uninstalled';

export const PLUGIN_V20_STATUSES: readonly PluginV20Status[] = [
  'available',
  'installed',
  'enabled',
  'disabled',
  'error',
  'uninstalled',
];

export type PluginV20Risk = 'low' | 'medium' | 'high';

/** Một quyền plugin yêu cầu — đã duyệt hay chưa quyết định có enable được không. */
export interface PluginV20Permission {
  /** Tên quyền, vd `network.fetch`, `fs.read`. */
  name: string;
  /** Mô tả cho người dùng hiểu quyền này làm gì. */
  description: string;
  /** true = quyền nguy hiểm (ghi file, chạy shell, đọc secret) — phải duyệt tay. */
  dangerous: boolean;
  /** true = người dùng đã duyệt quyền này. */
  approved: boolean;
}

/** Một plugin trong store v20. */
export interface PluginV20Entry {
  /** Id ổn định, vd `weather-tools`. */
  id: string;
  name: string;
  description: string;
  /** Version semver, vd `1.2.0`. */
  version: string;
  /** Version host tối thiểu, vd `1.33.0` — nhỏ hơn thì không cài được. */
  minHostVersion: string;
  author: string;
  /** Capability plugin cung cấp, vd `tools`, `hooks`, `commands`. */
  capabilities: string[];
  permissions: PluginV20Permission[];
  /** Dependency: id → version range cần, vd `{ "core-utils": "^2.0.0" }`. */
  dependencies: Record<string, string>;
  status: PluginV20Status;
  /** Lý do lỗi khi status = error (dependency thiếu, version không tương thích...). */
  errorReason?: string;
  installedAt?: number;
  enabledAt?: number;
}

/** Store plugin v20 — host giữ bền vững, panel render từ đây. */
export interface PluginV20Store {
  /** Version host hiện tại — dùng để check minHostVersion. */
  hostVersion: string;
  plugins: PluginV20Entry[];
  /** Tổng số lần cài/gỡ/enable/disable đã thực hiện (audit nhẹ). */
  changeCount: number;
}

export function createPluginV20Store(hostVersion: string, plugins: PluginV20Entry[] = []): PluginV20Store {
  return { hostVersion, plugins: plugins.map((p) => ({ ...p, permissions: p.permissions.map((x) => ({ ...x })), dependencies: { ...p.dependencies } })), changeCount: 0 };
}

// ---------------------------------------------------------------------------
// Version check (semver tối giản: major.minor.patch, không pre-release)
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parsePluginV20Version(raw: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** So sánh semver: -1 / 0 / 1. Version không parse được → null (không đoán). */
export function comparePluginV20Versions(a: string, b: string): number | null {
  const pa = parsePluginV20Version(a);
  const pb = parsePluginV20Version(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** true khi version thỏa range `^x.y.z` hoặc `>=x.y.z` hoặc `x.y.z` chính xác. Range lạ → false (fail-closed). */
export function pluginV20VersionSatisfies(version: string, range: string): boolean {
  const v = parsePluginV20Version(version);
  if (!v) return false;
  const r = range.trim();
  if (r.startsWith('^')) {
    const base = parsePluginV20Version(r.slice(1));
    if (!base) return false;
    if (comparePluginV20Versions(version, r.slice(1)) === null) return false;
    if ((comparePluginV20Versions(version, r.slice(1)) ?? -1) < 0) return false;
    // ^x.y.z: major phải giữ nguyên (trừ major 0 thì minor giữ nguyên).
    if (base[0] > 0) return v[0] === base[0];
    return v[0] === 0 && v[1] === base[1];
  }
  if (r.startsWith('>=')) {
    const c = comparePluginV20Versions(version, r.slice(2));
    return c !== null && c >= 0;
  }
  const c = comparePluginV20Versions(version, r);
  return c !== null && c === 0;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Validate một entry plugin: trả lỗi, rỗng = hợp lệ. */
export function validatePluginV20Entry(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Plugin v20 phải là một object.'];
  }
  const p = raw as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !PLUGIN_ID_RE.test(p['id'] as string)) {
    errors.push('Plugin cần "id" chữ thường/số/gạch ngang, bắt đầu bằng chữ cái.');
  }
  if (typeof p['name'] !== 'string' || (p['name'] as string).trim().length === 0) {
    errors.push('Plugin cần "name" không rỗng.');
  }
  if (typeof p['description'] !== 'string' || (p['description'] as string).trim().length === 0) {
    errors.push('Plugin cần "description" không rỗng — người dùng phải biết plugin làm gì trước khi cài.');
  }
  if (typeof p['version'] !== 'string' || !parsePluginV20Version(p['version'] as string)) {
    errors.push(`Plugin cần "version" semver x.y.z (nhận ${JSON.stringify(p['version'])}).`);
  }
  if (typeof p['minHostVersion'] !== 'string' || !parsePluginV20Version(p['minHostVersion'] as string)) {
    errors.push('Plugin cần "minHostVersion" semver x.y.z.');
  }
  if (!Array.isArray(p['capabilities'])) errors.push('Plugin cần "capabilities" là mảng (có thể rỗng).');
  if (!Array.isArray(p['permissions'])) {
    errors.push('Plugin cần "permissions" là mảng.');
  } else {
    (p['permissions'] as unknown[]).forEach((perm, i) => {
      if (perm === null || typeof perm !== 'object' || Array.isArray(perm)) {
        errors.push(`Quyền #${i + 1} phải là object { name, description, dangerous, approved }.`);
        return;
      }
      const q = perm as Record<string, unknown>;
      if (typeof q['name'] !== 'string' || (q['name'] as string).trim().length === 0) errors.push(`Quyền #${i + 1}: cần "name" không rỗng.`);
      if (typeof q['dangerous'] !== 'boolean') errors.push(`Quyền #${i + 1}: "dangerous" phải là boolean.`);
      if (typeof q['approved'] !== 'boolean') errors.push(`Quyền #${i + 1}: "approved" phải là boolean.`);
    });
  }
  if (p['dependencies'] !== null && typeof p['dependencies'] !== 'object' && p['dependencies'] !== undefined) {
    errors.push('Plugin: "dependencies" phải là object id → range (nếu có).');
  }
  if (!PLUGIN_V20_STATUSES.includes(p['status'] as PluginV20Status)) {
    errors.push(`Plugin: "status" phải là một trong ${PLUGIN_V20_STATUSES.join(', ')}.`);
  }
  return errors;
}

/** Mức rủi ro của plugin = quyền nguy hiểm chưa duyệt nhiều nhất thì càng cao. */
export function pluginV20Risk(entry: PluginV20Entry): PluginV20Risk {
  const unapprovedDangerous = entry.permissions.filter((p) => p.dangerous && !p.approved).length;
  const dangerous = entry.permissions.filter((p) => p.dangerous).length;
  if (unapprovedDangerous >= 2) return 'high';
  if (unapprovedDangerous === 1 || dangerous >= 3) return 'medium';
  return 'low';
}

/** Quyền nguy hiểm chưa duyệt — enable bị chặn cho tới khi duyệt hết. */
export function pluginV20UnapprovedDangerous(entry: PluginV20Entry): PluginV20Permission[] {
  return entry.permissions.filter((p) => p.dangerous && !p.approved);
}

// ---------------------------------------------------------------------------
// Dependency + compat check
// ---------------------------------------------------------------------------

export interface PluginV20DependencyProblem {
  dependencyId: string;
  requiredRange: string;
  /** `missing` = chưa cài, `version` = đã cài nhưng không thỏa range, `disabled` = đã cài nhưng đang tắt. */
  kind: 'missing' | 'version' | 'disabled';
  installedVersion?: string;
}

/** Kiểm tra dependency của entry trên store hiện tại. */
export function checkPluginV20Dependencies(
  entry: PluginV20Entry,
  store: PluginV20Store,
): PluginV20DependencyProblem[] {
  const problems: PluginV20DependencyProblem[] = [];
  for (const [depId, range] of Object.entries(entry.dependencies)) {
    const dep = store.plugins.find((p) => p.id === depId);
    if (!dep || dep.status === 'uninstalled' || dep.status === 'available') {
      problems.push({ dependencyId: depId, requiredRange: range, kind: 'missing' });
      continue;
    }
    if (!pluginV20VersionSatisfies(dep.version, range)) {
      problems.push({ dependencyId: depId, requiredRange: range, kind: 'version', installedVersion: dep.version });
      continue;
    }
    if (dep.status === 'disabled' || dep.status === 'error') {
      problems.push({ dependencyId: depId, requiredRange: range, kind: 'disabled', installedVersion: dep.version });
    }
  }
  return problems;
}

/** Kiểm tra tương thích host: trả lỗi, rỗng = cài được. */
export function checkPluginV20HostCompat(entry: PluginV20Entry, hostVersion: string): string[] {
  const cmp = comparePluginV20Versions(hostVersion, entry.minHostVersion);
  if (cmp === null) return [`Không so được version host ${JSON.stringify(hostVersion)} với minHostVersion ${JSON.stringify(entry.minHostVersion)} — version phải là semver x.y.z.`];
  if (cmp < 0) {
    return [`Plugin ${entry.id} ${entry.version} cần host >= ${entry.minHostVersion}, host hiện tại ${hostVersion} — cập nhật app trước khi cài.`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// State machine: hành động cho phép + chuyển trạng thái
// ---------------------------------------------------------------------------

export type PluginV20Action = 'install' | 'enable' | 'disable' | 'uninstall' | 'approve-permission';

/** Nút nào được phép bấm ở trạng thái hiện tại (panel chỉ hiện nút này). */
export function pluginV20AllowedActions(entry: PluginV20Entry): PluginV20Action[] {
  switch (entry.status) {
    case 'available':
      return ['install'];
    case 'installed':
      return ['enable', 'uninstall', 'approve-permission'];
    case 'enabled':
      return ['disable', 'uninstall'];
    case 'disabled':
      return ['enable', 'uninstall', 'approve-permission'];
    case 'error':
      return ['uninstall'];
    case 'uninstalled':
      return ['install'];
    default:
      return [];
  }
}

export interface PluginV20TransitionResult {
  store: PluginV20Store;
  /** true = chuyển trạng thái thành công. */
  ok: boolean;
  /** Lý do chặn / lỗi — rỗng khi ok. */
  errors: string[];
}

/** Helper: trả store mới với entry đã đổi (immutable-ish: copy nông đủ dùng cho panel). */
function withPluginUpdated(store: PluginV20Store, id: string, patch: Partial<PluginV20Entry>): PluginV20Store {
  return {
    ...store,
    plugins: store.plugins.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    changeCount: store.changeCount + 1,
  };
}

function pluginV20Fail(store: PluginV20Store, errors: string[]): PluginV20TransitionResult {
  return { store, ok: false, errors };
}

/**
 * Cài plugin: chỉ từ `available`/`uninstalled`; host không tương thích
 * → lỗi rõ, không cài. Cài xong ở `installed` (CHƯA enable) — enable
 * là bước riêng, sau khi duyệt quyền nguy hiểm.
 */
export function installPluginV20(
  store: PluginV20Store,
  pluginId: string,
  now: number = Date.now(),
): PluginV20TransitionResult {
  const entry = store.plugins.find((p) => p.id === pluginId);
  if (!entry) return pluginV20Fail(store, [`Không có plugin "${pluginId}" trong store — kiểm tra lại id.`]);
  if (!['available', 'uninstalled'].includes(entry.status)) {
    return pluginV20Fail(store, [`Plugin "${pluginId}" đang ở trạng thái ${entry.status}, không cài được (chỉ cài từ available/uninstalled).`]);
  }
  const compat = checkPluginV20HostCompat(entry, store.hostVersion);
  if (compat.length > 0) return pluginV20Fail(store, compat);
  const depProblems = checkPluginV20Dependencies(entry, store);
  if (depProblems.length > 0) {
    return pluginV20Fail(
      store,
      depProblems.map((d) =>
        d.kind === 'missing'
          ? `Thiếu dependency "${d.dependencyId}" (${d.requiredRange}) — cài dependency trước.`
          : d.kind === 'version'
            ? `Dependency "${d.dependencyId}" đang ở ${d.installedVersion ?? '?'}, cần ${d.requiredRange} — cập nhật dependency trước.`
            : `Dependency "${d.dependencyId}" đang tắt/lỗi — bật dependency trước khi cài plugin này.`,
      ),
    );
  }
  return {
    store: withPluginUpdated(store, pluginId, { status: 'installed', installedAt: now, errorReason: undefined }),
    ok: true,
    errors: [],
  };
}

/**
 * Enable plugin: chỉ từ `installed`/`disabled`; quyền nguy hiểm chưa
 * duyệt hết → chặn (người dùng phải duyệt từng quyền ở panel trước);
 * dependency thiếu/tắt → chặn. Enable xong ghi `enabledAt`.
 */
export function enablePluginV20(
  store: PluginV20Store,
  pluginId: string,
  now: number = Date.now(),
): PluginV20TransitionResult {
  const entry = store.plugins.find((p) => p.id === pluginId);
  if (!entry) return pluginV20Fail(store, [`Không có plugin "${pluginId}" trong store.`]);
  if (!['installed', 'disabled'].includes(entry.status)) {
    return pluginV20Fail(store, [`Plugin "${pluginId}" đang ở trạng thái ${entry.status}, không enable được (chỉ enable từ installed/disabled).`]);
  }
  const unapproved = pluginV20UnapprovedDangerous(entry);
  if (unapproved.length > 0) {
    return pluginV20Fail(
      store,
      unapproved.map((p) => `Quyền nguy hiểm "${p.name}" chưa được duyệt — duyệt quyền này ở panel Plugin trước khi enable.`),
    );
  }
  const depProblems = checkPluginV20Dependencies(entry, store);
  if (depProblems.length > 0) {
    return pluginV20Fail(store, depProblems.map((d) => `Không enable được: dependency "${d.dependencyId}" ${d.kind === 'missing' ? 'chưa cài' : d.kind === 'version' ? `sai version (cần ${d.requiredRange})` : 'đang tắt/lỗi'}.`));
  }
  return {
    store: withPluginUpdated(store, pluginId, { status: 'enabled', enabledAt: now, errorReason: undefined }),
    ok: true,
    errors: [],
  };
}

/** Disable plugin đang enabled → `disabled` (không gỡ, cài đặt giữ nguyên). */
export function disablePluginV20(store: PluginV20Store, pluginId: string): PluginV20TransitionResult {
  const entry = store.plugins.find((p) => p.id === pluginId);
  if (!entry) return pluginV20Fail(store, [`Không có plugin "${pluginId}" trong store.`]);
  if (entry.status !== 'enabled') {
    return pluginV20Fail(store, [`Plugin "${pluginId}" đang ở trạng thái ${entry.status}, không disable được (chỉ disable plugin đang enabled).`]);
  }
  // Không cho tắt plugin mà plugin khác đang enabled còn phụ thuộc vào nó.
  const dependents = store.plugins.filter(
    (p) => p.status === 'enabled' && p.id !== pluginId && Object.keys(p.dependencies).includes(pluginId),
  );
  if (dependents.length > 0) {
    return pluginV20Fail(
      store,
      dependents.map((p) => `Plugin "${p.id}" đang enabled và phụ thuộc vào "${pluginId}" — tắt "${p.id}" trước.`),
    );
  }
  return { store: withPluginUpdated(store, pluginId, { status: 'disabled' }), ok: true, errors: [] };
}

/**
 * Gỡ plugin: enabled → phải disable trước (tránh gỡ plugin đang chạy);
 * gỡ xong về `uninstalled` (giữ entry trong store để cài lại, kèm
 * installedAt/enabledAt đã xóa). Plugin khác phụ thuộc vào nó mà đang
 * enabled → chặn.
 */
export function uninstallPluginV20(store: PluginV20Store, pluginId: string): PluginV20TransitionResult {
  const entry = store.plugins.find((p) => p.id === pluginId);
  if (!entry) return pluginV20Fail(store, [`Không có plugin "${pluginId}" trong store.`]);
  if (entry.status === 'enabled') {
    return pluginV20Fail(store, [`Plugin "${pluginId}" đang enabled — disable trước khi gỡ.`]);
  }
  if (entry.status === 'available') {
    return pluginV20Fail(store, [`Plugin "${pluginId}" chưa được cài — không có gì để gỡ.`]);
  }
  const dependents = store.plugins.filter(
    (p) => p.status === 'enabled' && p.id !== pluginId && Object.keys(p.dependencies).includes(pluginId),
  );
  if (dependents.length > 0) {
    return pluginV20Fail(
      store,
      dependents.map((p) => `Plugin "${p.id}" đang enabled và phụ thuộc vào "${pluginId}" — tắt "${p.id}" trước.`),
    );
  }
  return {
    store: withPluginUpdated(store, pluginId, { status: 'uninstalled', installedAt: undefined, enabledAt: undefined, errorReason: undefined }),
    ok: true,
    errors: [],
  };
}

/** Duyệt một quyền nguy hiểm của plugin (người dùng bấm tay ở panel). */
export function approvePluginV20Permission(
  store: PluginV20Store,
  pluginId: string,
  permissionName: string,
): PluginV20TransitionResult {
  const entry = store.plugins.find((p) => p.id === pluginId);
  if (!entry) return pluginV20Fail(store, [`Không có plugin "${pluginId}" trong store.`]);
  const perm = entry.permissions.find((p) => p.name === permissionName);
  if (!perm) return pluginV20Fail(store, [`Plugin "${pluginId}" không yêu cầu quyền "${permissionName}".`]);
  if (perm.approved) return { store, ok: true, errors: [] };
  const next: PluginV20Store = {
    ...store,
    plugins: store.plugins.map((p) =>
      p.id === pluginId
        ? { ...p, permissions: p.permissions.map((q) => (q.name === permissionName ? { ...q, approved: true } : q)) }
        : p,
    ),
    changeCount: store.changeCount + 1,
  };
  return { store: next, ok: true, errors: [] };
}

/** Đánh dấu plugin lỗi (host phát hiện khi load, vd dependency vỡ sau cập nhật). */
export function markPluginV20Error(store: PluginV20Store, pluginId: string, reason: string): PluginV20Store {
  return withPluginUpdated(store, pluginId, { status: 'error', errorReason: reason });
}

// ---------------------------------------------------------------------------
// Tìm kiếm + tóm tắt cho panel
// ---------------------------------------------------------------------------

export interface PluginV20SearchFilters {
  query?: string;
  status?: PluginV20Status;
  /** true = chỉ plugin có quyền nguy hiểm chưa duyệt. */
  unapprovedDangerousOnly?: boolean;
  /** true = chỉ plugin có lỗi dependency. */
  dependencyProblemOnly?: boolean;
  capability?: string;
}

/** Search + lọc plugin cho panel (không phân biệt hoa/thường, khớp tên/mô tả/capability/id). */
export function searchPluginV20(store: PluginV20Store, filters: PluginV20SearchFilters = {}): PluginV20Entry[] {
  const q = (filters.query ?? '').trim().toLowerCase();
  return store.plugins
    .filter((p) => {
      if (filters.status && p.status !== filters.status) return false;
      if (filters.capability && !p.capabilities.includes(filters.capability)) return false;
      if (filters.unapprovedDangerousOnly && pluginV20UnapprovedDangerous(p).length === 0) return false;
      if (filters.dependencyProblemOnly && checkPluginV20Dependencies(p, store).length === 0) return false;
      if (q) {
        const hay = `${p.id} ${p.name} ${p.description} ${p.capabilities.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Tóm tắt store để panel hiện header + cảnh báo. */
export function summarizePluginV20Store(store: PluginV20Store): {
  total: number;
  enabled: number;
  installed: number;
  disabled: number;
  errored: number;
  available: number;
  highRisk: number;
  unapprovedDangerous: number;
  dependencyProblems: number;
  summary: string;
} {
  const count = (s: PluginV20Status): number => store.plugins.filter((p) => p.status === s).length;
  const highRisk = store.plugins.filter((p) => pluginV20Risk(p) === 'high').length;
  const unapprovedDangerous = store.plugins.reduce((n, p) => n + pluginV20UnapprovedDangerous(p).length, 0);
  const dependencyProblems = store.plugins.reduce((n, p) => n + checkPluginV20Dependencies(p, store).length, 0);
  return {
    total: store.plugins.length,
    enabled: count('enabled'),
    installed: count('installed'),
    disabled: count('disabled'),
    errored: count('error'),
    available: count('available') + count('uninstalled'),
    highRisk,
    unapprovedDangerous,
    dependencyProblems,
    summary:
      `Plugin: ${count('enabled')} đang bật / ${store.plugins.length} tổng` +
      (count('error') > 0 ? `, ${count('error')} lỗi` : '') +
      (unapprovedDangerous > 0 ? `, ${unapprovedDangerous} quyền nguy hiểm chưa duyệt` : '') +
      (dependencyProblems > 0 ? `, ${dependencyProblems} lỗi dependency` : ''),
  };
}
