/**
 * Coding agent v19 — Agent Plugins `mcp.json` (v1.41, Đội T4).
 *
 * Plugin manifest là file `mcp.json`: khai báo MCP server/plugin cho
 * coding agent (stdio/http/sse), validate schema trước khi load,
 * load/unload + bật/tắt từng server, config thực thi được chỉnh sửa
 * trực tiếp nhưng phải validate trước khi áp (schema + giá trị, secret
 * không bao giờ lộ ra ngoài qua render/list). Marketplace nội bộ liệt
 * kê plugin đã cài + catalog có sẵn để search theo tên/mô tả/nhóm.
 *
 * Ý tưởng học từ survey v141 §3 (OpenHands SDK v1.49.2: Agent Plugins
 * `mcp.json`; Canvas 1.38: editable executable plugin config). Code
 * của open-bot: validate + quản lý trạng thái thuần dữ liệu, không gọi
 * MCP server thật, không chạy command của plugin (host làm việc đó sau
 * khi user duyệt; ở đây chỉ khai báo + kiểm tra).
 */

import { CodingV19Error, V19_MAX_SERVERS_PER_PLUGIN } from './types';
import type {
  V19MarketplaceEntry,
  V19McpServerDef,
  V19McpTransport,
  V19PluginConfigApplyResult,
  V19PluginConfigChange,
  V19PluginConfigField,
  V19PluginManifest,
  V19PluginState,
  V19ValidationResult,
} from './types';

/** Tên plugin/server hợp lệ: slug chữ thường, số, '-' và '_'. */
export const V19_PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
/** Phiên bản hợp lệ: semver nới lỏng (1 / 1.2 / 1.2.3 + hậu tố). */
export const V19_PLUGIN_VERSION_RE = /^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;
/** Transport hợp lệ. */
export const V19_MCP_TRANSPORTS: readonly V19McpTransport[] = ['stdio', 'http', 'sse'];
/** Quyền hợp lệ mà plugin được xin. */
export const V19_PLUGIN_PERMISSIONS: readonly string[] = ['read', 'write', 'exec', 'network'];
/** Nhóm plugin hợp lệ. */
export const V19_PLUGIN_CATEGORIES: readonly string[] = [
  'filesystem',
  'git',
  'search',
  'database',
  'browser',
  'testing',
  'other',
];

/** Key nào trong config/env được coi là secret (phải che khi render). */
export function v19IsSecretKey(key: string): boolean {
  return /(password|passwd|secret|token|api[-_]?key|private[-_]?key|auth|credential)/i.test(key);
}

/** Che giá trị secret (giữ 2 ký tự đầu + 2 cuối để nhận diện, còn lại '*'). */
export function v19RedactSecret(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** Deep-clone JSON-safe (dùng khi copy manifest/config). */
export function v19CloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Validate một MCP server def, trả danh sách lỗi (rỗng = hợp lệ). */
export function v19ValidateMcpServer(server: V19McpServerDef, index: number): string[] {
  const errors: string[] = [];
  const where = `servers[${index}]`;
  if (!server || typeof server !== 'object') {
    errors.push(`${where} phải là object.`);
    return errors;
  }
  if (typeof server.id !== 'string' || !V19_PLUGIN_NAME_RE.test(server.id)) {
    errors.push(`${where}.id "${String(server.id)}" không hợp lệ (slug chữ thường, số, '-'/'_', tối đa 64 ký tự).`);
  }
  if (server.name !== undefined && (typeof server.name !== 'string' || server.name.trim() === '')) {
    errors.push(`${where}.name phải là string không rỗng.`);
  }
  if (!V19_MCP_TRANSPORTS.includes(server.transport)) {
    errors.push(`${where}.transport phải là stdio | http | sse (nhận "${String(server.transport)}").`);
  } else if (server.transport === 'stdio') {
    if (typeof server.command !== 'string' || server.command.trim() === '') {
      errors.push(`${where}.command bắt buộc với transport stdio (lệnh chạy MCP server).`);
    } else if (/[;&|`$]/.test(server.command)) {
      errors.push(`${where}.command không được chứa ký tự shell (; & | \` $) — command là một chương trình duy nhất, argument để ở args.`);
    }
    if (server.url !== undefined) errors.push(`${where}.url không dùng với transport stdio.`);
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string')) {
        errors.push(`${where}.args phải là mảng string.`);
      }
    }
    if (server.env !== undefined) {
      if (typeof server.env !== 'object' || Array.isArray(server.env)) {
        errors.push(`${where}.env phải là object string -> string.`);
      } else {
        for (const [key, value] of Object.entries(server.env)) {
          if (typeof value !== 'string') errors.push(`${where}.env["${key}"] phải là string.`);
        }
      }
    }
  } else {
    // http / sse
    if (typeof server.url !== 'string' || server.url.trim() === '') {
      errors.push(`${where}.url bắt buộc với transport ${server.transport}.`);
    } else if (!/^https?:\/\//i.test(server.url.trim())) {
      errors.push(`${where}.url phải bắt đầu bằng http:// hoặc https:// (nhận "${server.url}").`);
    }
    if (server.command !== undefined) errors.push(`${where}.command không dùng với transport ${server.transport}.`);
    if (server.headers !== undefined) {
      if (typeof server.headers !== 'object' || Array.isArray(server.headers)) {
        errors.push(`${where}.headers phải là object string -> string.`);
      } else {
        for (const [key, value] of Object.entries(server.headers)) {
          if (typeof value !== 'string') errors.push(`${where}.headers["${key}"] phải là string.`);
        }
      }
    }
  }
  if (server.timeoutMs !== undefined) {
    if (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 100 || server.timeoutMs > 600000) {
      errors.push(`${where}.timeoutMs phải là số nguyên 100..600000.`);
    }
  }
  if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
    errors.push(`${where}.enabled phải là boolean.`);
  }
  return errors;
}

/** Validate một field trong config schema của plugin. */
export function v19ValidateConfigField(field: V19PluginConfigField, key: string): string[] {
  const errors: string[] = [];
  if (!field || typeof field !== 'object') {
    errors.push(`configSchema["${key}"] phải là object.`);
    return errors;
  }
  if (!['string', 'number', 'boolean', 'string[]'].includes(field.type)) {
    errors.push(`configSchema["${key}"].type phải là string | number | boolean | string[] (nhận "${String(field.type)}").`);
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    errors.push(`configSchema["${key}"].required phải là boolean.`);
  }
  if (field.description !== undefined && typeof field.description !== 'string') {
    errors.push(`configSchema["${key}"].description phải là string.`);
  }
  if (field.default !== undefined) {
    const ok =
      (field.type === 'string' && typeof field.default === 'string') ||
      (field.type === 'number' && typeof field.default === 'number') ||
      (field.type === 'boolean' && typeof field.default === 'boolean') ||
      (field.type === 'string[]' && Array.isArray(field.default) && field.default.every((v) => typeof v === 'string'));
    if (!ok) errors.push(`configSchema["${key}"].default không khớp type "${field.type}".`);
  }
  return errors;
}

/**
 * Validate toàn bộ plugin manifest (mcp.json). Trả {ok, errors, warnings}.
 * Lỗi = chặn load; warning = load được nhưng nên sửa (vd thiếu mô tả,
 * xin quyền write/exec, server tắt mặc định).
 */
export function v19ValidateManifest(manifest: V19PluginManifest): V19ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['Manifest phải là JSON object.'], warnings };
  }
  if (typeof manifest.name !== 'string' || !V19_PLUGIN_NAME_RE.test(manifest.name)) {
    errors.push(`name "${String(manifest.name)}" không hợp lệ (slug chữ thường, số, '-'/'_', tối đa 64 ký tự).`);
  }
  if (typeof manifest.version !== 'string' || !V19_PLUGIN_VERSION_RE.test(manifest.version)) {
    errors.push(`version "${String(manifest.version)}" không hợp lệ (vd "1.2.0").`);
  }
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    errors.push('description phải là string.');
  } else if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    warnings.push('Plugin chưa có description — marketplace hiển thị sẽ trống.');
  }
  if (manifest.author !== undefined && typeof manifest.author !== 'string') {
    errors.push('author phải là string.');
  }
  if (manifest.category !== undefined && !V19_PLUGIN_CATEGORIES.includes(manifest.category)) {
    errors.push(`category phải là một trong: ${V19_PLUGIN_CATEGORIES.join(', ')} (nhận "${manifest.category}").`);
  }
  if (!Array.isArray(manifest.servers) || manifest.servers.length === 0) {
    errors.push('servers phải là mảng không rỗng (plugin cần ít nhất 1 MCP server).');
  } else {
    if (manifest.servers.length > V19_MAX_SERVERS_PER_PLUGIN) {
      errors.push(`Plugin có ${manifest.servers.length} server, vượt giới hạn ${V19_MAX_SERVERS_PER_PLUGIN}.`);
    }
    const seen = new Set<string>();
    manifest.servers.forEach((server, idx) => {
      errors.push(...v19ValidateMcpServer(server, idx));
      if (typeof server?.id === 'string') {
        if (seen.has(server.id)) errors.push(`servers[${idx}].id "${server.id}" bị trùng.`);
        seen.add(server.id);
      }
      if (server?.enabled === false) warnings.push(`Server "${server?.id ?? idx}" tắt mặc định (enabled=false).`);
    });
  }
  if (manifest.tools !== undefined) {
    if (!Array.isArray(manifest.tools) || manifest.tools.some((t) => typeof t !== 'string' || t.trim() === '')) {
      errors.push('tools phải là mảng string không rỗng.');
    } else if (new Set(manifest.tools).size !== manifest.tools.length) {
      errors.push('tools không được trùng nhau.');
    }
  }
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some((p) => !V19_PLUGIN_PERMISSIONS.includes(p))) {
      errors.push(`permissions chỉ gồm: ${V19_PLUGIN_PERMISSIONS.join(', ')}.`);
    } else {
      if (manifest.permissions.includes('write')) warnings.push('Plugin xin quyền write (ghi file).');
      if (manifest.permissions.includes('exec')) warnings.push('Plugin xin quyền exec (chạy lệnh).');
      if (manifest.permissions.includes('network')) warnings.push('Plugin xin quyền network.');
    }
  }
  if (manifest.config !== undefined && (typeof manifest.config !== 'object' || Array.isArray(manifest.config))) {
    errors.push('config phải là JSON object.');
  }
  if (manifest.configSchema !== undefined) {
    if (typeof manifest.configSchema !== 'object' || Array.isArray(manifest.configSchema)) {
      errors.push('configSchema phải là object key -> field.');
    } else {
      for (const [key, field] of Object.entries(manifest.configSchema)) {
        errors.push(...v19ValidateConfigField(field, key));
      }
      // Config hiện tại phải khớp schema (required + type).
      if (manifest.config) {
        const configErrors = v19ValidateConfigAgainstSchema(manifest.config, manifest.configSchema);
        errors.push(...configErrors.map((e) => `config: ${e}`));
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Validate một config object theo schema (required + type từng key). */
export function v19ValidateConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: Record<string, V19PluginConfigField>,
): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['Config phải là JSON object.'];
  }
  for (const [key, field] of Object.entries(schema)) {
    const value = config[key];
    if (value === undefined) {
      if (field.required) errors.push(`Thiếu config bắt buộc "${key}".`);
      continue;
    }
    const ok =
      (field.type === 'string' && typeof value === 'string') ||
      (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (field.type === 'boolean' && typeof value === 'boolean') ||
      (field.type === 'string[]' && Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (!ok) errors.push(`Config "${key}" phải là ${field.type} (nhận ${typeof value}).`);
  }
  for (const key of Object.keys(config)) {
    if (!(key in schema)) errors.push(`Config "${key}" không có trong configSchema (key lạ — kiểm tra lại tên).`);
  }
  return errors;
}

/** Parse mcp.json từ text (JSON), validate, trả manifest (throw khi lỗi). */
export function v19ParseManifestJson(json: string): V19PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodingV19Error('mcp.json không phải JSON hợp lệ.');
  }
  const result = v19ValidateManifest(parsed as V19PluginManifest);
  if (!result.ok) {
    throw new CodingV19Error(`mcp.json không hợp lệ:\n- ${result.errors.join('\n- ')}`);
  }
  return v19NormalizeManifest(parsed as V19PluginManifest);
}

/** Chuẩn hoá manifest: default category/tools/permissions/config + enabled mặc định true. */
export function v19NormalizeManifest(manifest: V19PluginManifest): V19PluginManifest {
  const normalized: V19PluginManifest = {
    name: manifest.name,
    version: manifest.version,
    servers: manifest.servers.map((s) => ({
      ...s,
      enabled: s.enabled ?? true,
      args: s.args ? [...s.args] : undefined,
      env: s.env ? { ...s.env } : undefined,
      headers: s.headers ? { ...s.headers } : undefined,
      timeoutMs: s.timeoutMs ?? 30000,
    })),
    category: manifest.category ?? 'other',
    tools: manifest.tools ? [...manifest.tools] : [],
    permissions: manifest.permissions ? [...manifest.permissions] : ['read'],
    config: manifest.config ? { ...manifest.config } : {},
  };
  if (manifest.description !== undefined) normalized.description = manifest.description;
  if (manifest.author !== undefined) normalized.author = manifest.author;
  if (manifest.configSchema !== undefined) normalized.configSchema = v19CloneJson(manifest.configSchema);
  return normalized;
}

/** Serialize manifest thành mcp.json text (ghi file). */
export function v19ManifestToJson(manifest: V19PluginManifest): string {
  const result = v19ValidateManifest(manifest);
  if (!result.ok) {
    throw new CodingV19Error(`Không ghi được mcp.json không hợp lệ:\n- ${result.errors.join('\n- ')}`);
  }
  return `${JSON.stringify(v19NormalizeManifest(manifest), null, 2)}\n`;
}

/**
 * Load plugin: validate manifest rồi tạo state (loaded, server enabled
 * theo manifest, config = config mặc định). Throw khi manifest lỗi.
 */
export function v19LoadPlugin(manifest: V19PluginManifest, now?: number): V19PluginState {
  const result = v19ValidateManifest(manifest);
  if (!result.ok) {
    throw new CodingV19Error(`Không load được plugin "${manifest?.name ?? ''}":\n- ${result.errors.join('\n- ')}`);
  }
  const normalized = v19NormalizeManifest(manifest);
  return {
    manifest: normalized,
    loaded: true,
    enabledServers: normalized.servers.filter((s) => s.enabled !== false).map((s) => s.id),
    appliedConfig: v19CloneJson(normalized.config ?? {}),
    configVersion: 1,
    loadedAt: typeof now === 'number' ? now : Date.now(),
  };
}

/** Unload plugin (giữ manifest + config, chỉ đổi loaded + enabled rỗng). */
export function v19UnloadPlugin(state: V19PluginState): V19PluginState {
  if (!state.loaded) throw new CodingV19Error(`Plugin "${state.manifest.name}" chưa load — không unload được.`);
  return { ...state, loaded: false, enabledServers: [] };
}

/** Bật/tắt một server của plugin đã load (throw khi server không có / plugin chưa load). */
export function v19SetServerEnabled(
  state: V19PluginState,
  serverId: string,
  enabled: boolean,
): V19PluginState {
  if (!state.loaded) throw new CodingV19Error(`Plugin "${state.manifest.name}" chưa load — bật/tắt server phải load trước.`);
  if (!state.manifest.servers.some((s) => s.id === serverId)) {
    throw new CodingV19Error(`Plugin "${state.manifest.name}" không có server "${serverId}".`);
  }
  const enabledServers = enabled
    ? [...new Set([...state.enabledServers, serverId])]
    : state.enabledServers.filter((id) => id !== serverId);
  return { ...state, enabledServers };
}

/**
 * Áp thay đổi config plugin (editable executable plugin config):
 * validate trước khi áp — config mới phải khớp configSchema (nếu có),
 * server bật/tắt phải tồn tại, không áp một phần (áp sai thì giữ
 * nguyên state cũ). Trả state mới + kết quả áp.
 */
export function v19ApplyPluginConfig(
  state: V19PluginState,
  change: V19PluginConfigChange,
): { state: V19PluginState; result: V19PluginConfigApplyResult } {
  if (!state.loaded) {
    const result: V19PluginConfigApplyResult = {
      pluginName: state.manifest.name,
      applied: false,
      configVersion: state.configVersion,
      appliedConfig: v19CloneJson(state.appliedConfig),
      enabledServers: [...state.enabledServers],
      errors: [`Plugin "${state.manifest.name}" chưa load — load trước khi sửa config.`],
    };
    return { state, result };
  }
  if (change.pluginName !== state.manifest.name) {
    throw new CodingV19Error(`Config change cho plugin "${change.pluginName}" nhưng state là "${state.manifest.name}".`);
  }
  const errors: string[] = [];
  const nextConfig = change.replace === true
    ? v19CloneJson(change.config)
    : { ...v19CloneJson(state.appliedConfig), ...v19CloneJson(change.config) };
  if (state.manifest.configSchema) {
    errors.push(...v19ValidateConfigAgainstSchema(nextConfig, state.manifest.configSchema));
  }
  let nextEnabled = [...state.enabledServers];
  if (change.enabledServers !== undefined) {
    const unknown = change.enabledServers.filter((id) => !state.manifest.servers.some((s) => s.id === id));
    if (unknown.length > 0) errors.push(`Không có server: ${unknown.join(', ')}.`);
    else nextEnabled = [...new Set(change.enabledServers)];
  }
  if (errors.length > 0) {
    return {
      state,
      result: {
        pluginName: state.manifest.name,
        applied: false,
        configVersion: state.configVersion,
        appliedConfig: v19CloneJson(state.appliedConfig),
        enabledServers: [...state.enabledServers],
        errors,
      },
    };
  }
  const nextState: V19PluginState = {
    ...state,
    appliedConfig: nextConfig,
    enabledServers: nextEnabled,
    configVersion: state.configVersion + 1,
  };
  return {
    state: nextState,
    result: {
      pluginName: state.manifest.name,
      applied: true,
      configVersion: nextState.configVersion,
      appliedConfig: v19CloneJson(nextConfig),
      enabledServers: nextEnabled,
      errors: [],
    },
  };
}

/** Lấy config đã áp, che secret (dùng cho list/render, không lộ secret). */
export function v19RedactedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (v19IsSecretKey(key) && typeof value === 'string') out[key] = v19RedactSecret(value);
    else out[key] = value;
  }
  return out;
}

/** Render manifest tóm tắt (che secret trong env/config). */
export function renderV19PluginManifest(manifest: V19PluginManifest): string {
  const lines = [
    `Plugin ${manifest.name} v${manifest.version}${manifest.description ? ` — ${manifest.description}` : ''}`,
    `Nhóm: ${manifest.category ?? 'other'} — quyền: ${(manifest.permissions ?? ['read']).join(', ')}.`,
  ];
  for (const server of manifest.servers) {
    const where = server.transport === 'stdio' ? (server.command ?? '') : (server.url ?? '');
    lines.push(`  - server ${server.id} (${server.transport}): ${where}${server.enabled === false ? ' [tắt]' : ''}`);
  }
  if (manifest.tools && manifest.tools.length > 0) lines.push(`Tool: ${manifest.tools.join(', ')}.`);
  return lines.join('\n');
}

/** Render state plugin (loaded/enabled/config đã che secret). */
export function renderV19PluginState(state: V19PluginState): string {
  const redacted = v19RedactedConfig(state.appliedConfig);
  return (
    `${renderV19PluginManifest(state.manifest)}\n` +
    `Trạng thái: ${state.loaded ? 'loaded' : 'unloaded'} — server đang bật: ${state.enabledServers.join(', ') || '(không có)'} — config v${state.configVersion}: ${JSON.stringify(redacted)}.`
  );
}

/* ------------------------------------------------------------------ */
/* Marketplace nội bộ                                                  */
/* ------------------------------------------------------------------ */

/** Catalog có sẵn (plugin biết tới, chưa cài manifest vẫn search được). */
export const V19_PLUGIN_CATALOG: readonly V19MarketplaceEntry[] = [
  { name: 'filesystem', version: '1.0.0', description: 'Đọc/ghi file trong workspace của conversation.', category: 'filesystem', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_workspace'] },
  { name: 'git-helper', version: '1.0.0', description: 'Trạng thái git, diff và log của repo trong workspace.', category: 'git', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_diff'] },
  { name: 'code-search', version: '1.0.0', description: 'Tìm kiếm ký hiệu và chuỗi trong workspace.', category: 'search', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_workspace'] },
  { name: 'test-runner', version: '1.0.0', description: 'Chạy test trong workspace và báo cáo kết quả.', category: 'testing', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_agent'] },
  { name: 'web-fetch', version: '1.0.0', description: 'Lấy nội dung trang web qua HTTP (chỉ đọc).', category: 'browser', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_events'] },
  { name: 'sqlite-notes', version: '1.0.0', description: 'Ghi chú có cấu trúc trong workspace (SQLite local).', category: 'database', source: 'catalog', loaded: false, enabledServers: 0, totalServers: 1, tools: ['coding_v19_checkpoint'] },
];

/** Gộp plugin đã cài + catalog thành danh sách marketplace (đã cài thắng catalog trùng tên). */
export function v19MarketplaceList(
  installed: readonly V19PluginState[],
  includeCatalog = true,
): V19MarketplaceEntry[] {
  const byName = new Map<string, V19MarketplaceEntry>();
  if (includeCatalog) {
    for (const entry of V19_PLUGIN_CATALOG) byName.set(entry.name, { ...entry });
  }
  for (const state of installed) {
    byName.set(state.manifest.name, {
      name: state.manifest.name,
      version: state.manifest.version,
      description: state.manifest.description ?? '',
      category: state.manifest.category ?? 'other',
      source: 'installed',
      loaded: state.loaded,
      enabledServers: state.enabledServers.length,
      totalServers: state.manifest.servers.length,
      tools: [...(state.manifest.tools ?? [])],
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Search marketplace: khớp tên/mô tả/nhóm (không phân biệt hoa thường), lọc theo category khi có. */
export function v19MarketplaceSearch(
  entries: readonly V19MarketplaceEntry[],
  query: string,
  category?: string,
): V19MarketplaceEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (category && category !== '' && e.category !== category) return false;
    if (q === '') return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.tools.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** Render danh sách marketplace (một dòng một plugin). */
export function renderV19Marketplace(entries: readonly V19MarketplaceEntry[]): string {
  if (entries.length === 0) return '(không có plugin nào khớp)';
  return entries
    .map(
      (e) =>
        `${e.name} v${e.version} [${e.category}] (${e.source}${e.source === 'installed' ? `, ${e.loaded ? 'loaded' : 'unloaded'}, ${e.enabledServers}/${e.totalServers} server bật` : ''}) — ${e.description}`,
    )
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Template scaffold plugin mới                                        */
/* ------------------------------------------------------------------ */

/** Starter manifest theo nhóm — scaffold plugin mới rồi sửa tiếp. */
export function v19PluginManifestTemplate(category: string, name = 'my-plugin'): V19PluginManifest {
  if (!V19_PLUGIN_CATEGORIES.includes(category)) {
    throw new CodingV19Error(`category phải là một trong: ${V19_PLUGIN_CATEGORIES.join(', ')} (nhận "${category}").`);
  }
  if (typeof name !== 'string' || !V19_PLUGIN_NAME_RE.test(name)) {
    throw new CodingV19Error(`Tên plugin "${name}" không hợp lệ (slug chữ thường, số, '-'/'_').`);
  }
  const byCategory: Record<string, { description: string; server: V19McpServerDef; tools: string[]; permissions: string[]; config: Record<string, unknown>; configSchema: Record<string, V19PluginConfigField> }> = {
    filesystem: {
      description: 'Read/write files inside the conversation workspace.',
      server: { id: 'fs', transport: 'stdio', command: 'node', args: ['server.js'], env: { FS_ROOT: '.' } },
      tools: ['coding_v19_workspace'],
      permissions: ['read', 'write'],
      config: { rootDir: '.', maxDepth: 5 },
      configSchema: {
        rootDir: { type: 'string', required: true, description: 'Thư mục gốc plugin được đọc/ghi.' },
        maxDepth: { type: 'number', required: false, default: 5 },
      },
    },
    git: {
      description: 'Git status, diff and log for the workspace repo.',
      server: { id: 'git', transport: 'stdio', command: 'git-mcp', args: [] },
      tools: ['coding_v19_diff'],
      permissions: ['read'],
      config: { repoPath: '.' },
      configSchema: { repoPath: { type: 'string', required: true } },
    },
    search: {
      description: 'Search symbols and text inside the workspace.',
      server: { id: 'search', transport: 'stdio', command: 'node', args: ['search.js'] },
      tools: ['coding_v19_workspace'],
      permissions: ['read'],
      config: { maxResults: 50 },
      configSchema: { maxResults: { type: 'number', required: false, default: 50 } },
    },
    database: {
      description: 'Query a local database (read-only by default).',
      server: { id: 'db', transport: 'stdio', command: 'node', args: ['db.js'] },
      tools: ['coding_v19_checkpoint'],
      permissions: ['read'],
      config: { dbPath: './data.db', readOnly: true },
      configSchema: {
        dbPath: { type: 'string', required: true },
        readOnly: { type: 'boolean', required: false, default: true },
      },
    },
    browser: {
      description: 'Fetch web pages over HTTP (read-only).',
      server: { id: 'web', transport: 'http', url: 'https://example.com/mcp' },
      tools: ['coding_v19_events'],
      permissions: ['read', 'network'],
      config: { timeoutMs: 30000 },
      configSchema: { timeoutMs: { type: 'number', required: false, default: 30000 } },
    },
    testing: {
      description: 'Run tests inside the workspace and report results.',
      server: { id: 'tests', transport: 'stdio', command: 'node', args: ['test.js'] },
      tools: ['coding_v19_agent'],
      permissions: ['read', 'exec'],
      config: { testCommand: 'npm test' },
      configSchema: { testCommand: { type: 'string', required: true } },
    },
    other: {
      description: 'Custom plugin — replace the server with your own MCP server.',
      server: { id: 'main', transport: 'stdio', command: 'node', args: ['server.js'] },
      tools: [],
      permissions: ['read'],
      config: {},
      configSchema: {},
    },
  };
  const template = byCategory[category]!;
  const manifest: V19PluginManifest = {
    name,
    version: '0.1.0',
    description: template.description,
    category,
    servers: [template.server],
    tools: template.tools,
    permissions: template.permissions,
    config: template.config,
    configSchema: template.configSchema,
  };
  const validation = v19ValidateManifest(manifest);
  if (!validation.ok) {
    throw new CodingV19Error(`Template plugin lỗi nội bộ (không nên xảy ra): ${validation.errors.join('; ')}`);
  }
  return manifest;
}
