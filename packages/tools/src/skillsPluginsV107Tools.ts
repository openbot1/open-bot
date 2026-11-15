/**
 * Agent tools for v1.07 skills & plugins (Team T4).
 *
 * Eight tools wiring the new core modules out to the agent loop:
 *  - `skill_list_directory` (read-only): tier-1 skills active for a
 *    working directory (directory-scoped progressive disclosure).
 *  - `skill_show` (read-only): load one skill's body (tier 2) by name.
 *  - `plugin_bundle_install` (needs approval): install a plugin
 *    bundle (skill + hook + MCP config) from a directory.
 *  - `plugin_bundle_list` (read-only): installed bundles + their
 *    components, validity and enabled flag.
 *  - `plugin_bundle_toggle` (needs approval): enable/disable a bundle.
 *  - `hook_config_apply` (needs approval): apply a declarative
 *    hooks.json file (registers its hooks).
 *  - `secret_request`: create an inline secret request in the chat —
 *    returns the prompt payload (JSON) the host renders; the value is
 *    NEVER returned by any tool here.
 *  - `secret_request_status` (read-only): status of a request
 *    (pending / fulfilled / declined / expired / cancelled) — status
 *    only, never the value.
 *
 * Factory:
 *   createSkillsPluginsV107Tools(opts?) -> Tool[] (bound, usable)
 *   SKILLS_PLUGINS_V107_TOOLS             (unbound placeholders)
 *
 * The placeholders are registered in ALL_TOOLS (see tools.ts); the
 * coordinator replaces them with bound tools via
 * `createDefaultTools({ getSkillsPluginsV107Opts })` — same
 * replace-in-place pattern as the internet-data / fleet tools, never
 * a duplicate. An unbound tool returns a clear "not configured"
 * error instead of guessing a directory or a registry.
 *
 * Security: no tool here ever returns a secret value. `secret_request`
 * returns only the prompt metadata; `secret_request_status` returns
 * only the status. The value flows user → Vault → the tool that
 * needs it (via `InlineSecretService.ensureSecret`), never through
 * a tool result the model can read.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import type {
  HookRegistry,
  InlineSecretService,
  SkillRegistry,
} from '@open-bot/core';
import {
  activatePluginBundle,
  applyHooksConfig,
  findHooksConfigFiles,
  installPluginBundle,
  listPluginBundles,
  loadHooksConfigFile,
  setPluginBundleEnabled,
} from '@open-bot/core/dist/index.js';

/** Tool names in this module (registry test asserts they are all in ALL_TOOLS). */
export const SKILLS_PLUGINS_V107_TOOL_NAMES = [
  'skill_list_directory',
  'skill_show',
  'plugin_bundle_install',
  'plugin_bundle_list',
  'plugin_bundle_toggle',
  'hook_config_apply',
  'secret_request',
  'secret_request_status',
] as const;

/** Factory options — the host resolves directories / registries lazily. */
export interface SkillsPluginsV107ToolOptions {
  /** Workspace root (scope patterns + hooks config resolve against it). */
  getWorkspaceDir?: () => string | null;
  /** Plugins dir (`<userData>/plugins`) for bundle install/list/toggle. */
  getPluginsDir?: () => string | null;
  getSkillRegistry?: () => SkillRegistry | null;
  getHookRegistry?: () => HookRegistry | null;
  getSecretService?: () => InlineSecretService | null;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Tham số "${name}" phải là chuỗi, nhận được ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Tham số "${name}" phải là boolean, nhận được ${typeof value}`);
  }
  return value;
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  required = false,
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}"`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Tham số "${name}" phải là số, nhận được ${typeof value}`);
  }
  return value;
}

function requireDir(getter: (() => string | null) | undefined, what: string): string {
  const dir = getter?.() ?? null;
  if (!dir || typeof dir !== 'string' || dir.trim() === '') {
    throw new Error(
      `Chưa cấu hình ${what} — host cần truyền resolver cho createSkillsPluginsV107Tools. Không tự đoán thư mục.`,
    );
  }
  return dir;
}

function requireRegistry<T>(
  getter: (() => T | null) | undefined,
  what: string,
): T {
  const registry = getter?.() ?? null;
  if (!registry) {
    throw new Error(
      `Chưa cấu hình ${what} — host cần truyền resolver cho createSkillsPluginsV107Tools.`,
    );
  }
  return registry;
}

/** Cap for a skill body returned by `skill_show` (avoids context blow-up). */
export const SKILL_SHOW_MAX_CHARS = 8000;

export function createSkillsPluginsV107Tools(
  opts: SkillsPluginsV107ToolOptions = {},
): Tool[] {
  const listDirectoryTool: Tool = {
    definition: {
      name: 'skill_list_directory',
      description:
        'Liệt kê các skill đang hoạt động (tier-1: tên + mô tả) cho một thư mục làm việc — skill có scope ' +
        'chỉ hiện khi thư mục nằm trong phạm vi của nó, skill toàn cục luôn hiện. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          workingDir: {
            type: 'string',
            description: 'Thư mục làm việc (tương đối so với workspace, hoặc tuyệt đối). Mặc định là gốc workspace.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const workspaceDir = requireDir(opts.getWorkspaceDir, 'thư mục workspace');
        const registry = requireRegistry(opts.getSkillRegistry, 'SkillRegistry');
        const workingDir = getStringArg(args, 'workingDir', false) || '.';
        const index = registry.directorySkillIndex(workingDir, workspaceDir);
        const lines: string[] = [
          `Skill cho thư mục ${JSON.stringify(path.resolve(workspaceDir, workingDir))} ` +
            `(${index.inScope}/${index.totalSkills} skill, ${index.hiddenByScope} bị ẩn bởi scope):`,
        ];
        if (index.entries.length === 0) {
          lines.push('(không có skill nào trong phạm vi)');
        } else {
          for (const entry of index.entries) {
            lines.push(`- ${entry.name}: ${entry.description}`);
          }
        }
        if (index.hiddenNames.length > 0) {
          lines.push(`Bị ẩn bởi scope (${index.hiddenNames.length}): ${index.hiddenNames.join(', ')}`);
        }
        lines.push(`Ước tính token của index: ~${index.estimatedTokens}.`);
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const showSkillTool: Tool = {
    definition: {
      name: 'skill_show',
      description:
        'Đọc nội dung đầy đủ (tier-2) của một skill theo tên — hướng dẫn chi tiết chỉ load khi skill được gọi. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Tên skill (ví dụ "code-review").',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const registry = requireRegistry(opts.getSkillRegistry, 'SkillRegistry');
        const name = getStringArg(args, 'name');
        const skill = registry.loadBody(name);
        if (!skill) {
          return errorResult(`Không tìm thấy skill "${name}" (hoặc skill đang bị tắt / không load được body).`);
        }
        const lines = [
          `Skill "${skill.name}" (v${skill.version}, nguồn: ${skill.source}):`,
          skill.description,
          `Phạm vi: ${skill.scope && skill.scope.length > 0 ? skill.scope.join(', ') : 'toàn cục'}`,
          '---',
        ];
        const body = skill.body;
        if (body.length > SKILL_SHOW_MAX_CHARS) {
          lines.push(
            body.slice(0, SKILL_SHOW_MAX_CHARS) +
              `\n[... body dài ${body.length} ký tự, đã cắt ở ${SKILL_SHOW_MAX_CHARS} ...]`,
          );
        } else {
          lines.push(body);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bundleInstallTool: Tool = {
    definition: {
      name: 'plugin_bundle_install',
      description:
        'Cài một plugin bundle (skill + hook + MCP config, một gói duy nhất) từ một thư mục trên máy vào thư mục plugins. ' +
        'Manifest được kiểm tra trước khi cài: sai là dừng, không ghi file nào. Cần duyệt vì thay đổi hệ thống.',
      parameters: {
        type: 'object',
        properties: {
          sourceDir: {
            type: 'string',
            description: 'Thư mục chứa bundle (có manifest.json ở gốc).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Ghi đè bundle cùng id đã cài (mặc định false — trùng id thì báo lỗi).',
          },
        },
        required: ['sourceDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const pluginsDir = requireDir(opts.getPluginsDir, 'thư mục plugins');
        const sourceDir = getStringArg(args, 'sourceDir');
        const overwrite = getBoolArg(args, 'overwrite', false);
        const result = installPluginBundle(sourceDir, pluginsDir, { overwrite });
        if (!result.ok) {
          return errorResult(
            `Không cài được bundle: ${(result.issues ?? ['lỗi không rõ']).join('; ')}`,
          );
        }
        const manifest = result.manifest!;
        const lines = [
          `Đã cài bundle "${manifest.id}" v${manifest.version} vào ${JSON.stringify(result.dir!)}.`,
          `Mô tả: ${manifest.description}`,
          `Skill: ${manifest.skills?.length ?? 0} thư mục; Hook: ${manifest.hooks?.length ?? 0}; MCP server: ${Object.keys(manifest.mcpServers ?? {}).length}; Tool entry: ${manifest.main ? 'có' : 'không'}.`,
        ];
        if (result.overwritten) lines.push('Đã ghi đè bản cài trước đó.');
        lines.push('Bundle chưa kích hoạt — host cần gọi activatePluginBundle (đăng ký skill/hook, gộp MCP server) để dùng.');
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bundleListTool: Tool = {
    definition: {
      name: 'plugin_bundle_list',
      description:
        'Liệt kê các plugin bundle đã cài: id, phiên bản, trạng thái bật/tắt, tính hợp lệ của manifest và thành phần (skill/hook/MCP). Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute() {
      try {
        const pluginsDir = requireDir(opts.getPluginsDir, 'thư mục plugins');
        const bundles = listPluginBundles(pluginsDir);
        if (bundles.length === 0) return 'Chưa cài plugin bundle nào.';
        const lines: string[] = [`Plugin bundle đã cài (${bundles.length}):`];
        for (const bundle of bundles) {
          const state = !bundle.valid
            ? 'MANIFEST LỖI'
            : bundle.enabled === false
              ? 'đã tắt'
              : 'đang bật';
          lines.push(
            `- ${bundle.pluginId} v${bundle.version || '?'} [${state}]: ${bundle.description || bundle.name} ` +
              `(skill: ${bundle.skillDirs.length}, hook: ${bundle.hookNames.length}, MCP: ${bundle.mcpServerNames.length})`,
          );
          if (!bundle.valid) {
            for (const issue of bundle.issues) lines.push(`    ! ${issue}`);
          }
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bundleToggleTool: Tool = {
    definition: {
      name: 'plugin_bundle_toggle',
      description:
        'Bật hoặc tắt một plugin bundle đã cài (ghi vào enabled.json). Tắt bundle không gỡ file của nó. Cần duyệt vì thay đổi trạng thái hệ thống.',
      parameters: {
        type: 'object',
        properties: {
          pluginId: {
            type: 'string',
            description: 'Id của bundle (thư mục cài).',
          },
          enabled: {
            type: 'boolean',
            description: 'true = bật, false = tắt.',
          },
        },
        required: ['pluginId', 'enabled'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const pluginsDir = requireDir(opts.getPluginsDir, 'thư mục plugins');
        const pluginId = getStringArg(args, 'pluginId');
        const enabled = getBoolArg(args, 'enabled', true);
        const result = setPluginBundleEnabled(pluginsDir, pluginId, enabled);
        if (!result.ok) {
          return errorResult((result.issues ?? ['lỗi không rõ']).join('; '));
        }
        return `Bundle "${pluginId}" đã ${enabled ? 'bật' : 'tắt'}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const hookConfigApplyTool: Tool = {
    definition: {
      name: 'hook_config_apply',
      description:
        'Áp dụng một file hooks.json khai báo hook (script hoặc shell command) vào HookRegistry: đăng ký các hook trong file ' +
        'để chạy ở các điểm vòng đời (PreToolUse/PostToolUse/Stop/SessionStart…). Không có filePath thì dùng .open-bot/hooks.json của workspace. Cần duyệt vì đăng ký hook thay đổi hành vi agent.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Đường dẫn file hooks.json (tương đối so với workspace hoặc tuyệt đối). Bỏ trống = tự tìm trong workspace.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const workspaceDir = requireDir(opts.getWorkspaceDir, 'thư mục workspace');
        const registry = requireRegistry(opts.getHookRegistry, 'HookRegistry');
        let filePath = getStringArg(args, 'filePath', false);
        if (!filePath) {
          const found = findHooksConfigFiles(workspaceDir);
          if (found.length === 0) {
            return errorResult(
              'Không tìm thấy file hooks.json trong workspace (.open-bot/hooks.json hoặc hooks.json) — hãy truyền filePath.',
            );
          }
          filePath = found[0]!;
        } else if (!path.isAbsolute(filePath)) {
          filePath = path.join(workspaceDir, filePath);
        }
        const parsed = loadHooksConfigFile(filePath);
        if (parsed.issues.length > 0) {
          return errorResult(`File hooks không hợp lệ: ${parsed.issues.join('; ')}`);
        }
        const applied = applyHooksConfig(registry, parsed.entries, {
          workspaceDir,
        });
        const lines = [
          `Đã áp dụng hooks từ ${JSON.stringify(filePath)}:`,
          `Đăng ký: ${applied.applied.length > 0 ? applied.applied.join(', ') : '(không có)'}`,
          `Bỏ qua (disabled): ${applied.skipped.length > 0 ? applied.skipped.join(', ') : '(không có)'}`,
        ];
        if (applied.invalid.length > 0) {
          lines.push('Lỗi đăng ký:');
          for (const entry of applied.invalid) {
            lines.push(`  - ${entry.name}: ${entry.issues.join('; ')}`);
          }
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretRequestTool: Tool = {
    definition: {
      name: 'secret_request',
      description:
        'Xin một secret (API key…) ngay trong chat khi tool cần key chưa có trong Vault: tạo yêu cầu inline để host hiện ô nhập mật khẩu cho user. ' +
        'Trả về payload của prompt (chỉ metadata, KHÔNG bao giờ trả giá trị secret). Nếu Vault đã có secret thì báo ngay, không tạo prompt.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'Namespace trong Vault, ví dụ "composio", "media-keys".',
          },
          key: {
            type: 'string',
            description: 'Key trong namespace, ví dụ "api-key".',
          },
          label: {
            type: 'string',
            description: 'Nhãn hiển thị cho user, ví dụ "Composio API key".',
          },
          hint: {
            type: 'string',
            description: 'Gợi ý hiển thị dưới ô nhập (không bao giờ là giá trị hay một phần key).',
          },
          reason: {
            type: 'string',
            description: 'Vì sao cần secret này.',
          },
          requestedBy: {
            type: 'string',
            description: 'Tên tool yêu cầu secret.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Thời gian chờ user trả lời (ms, 10.000–3.600.000; mặc định 300.000).',
          },
        },
        required: ['namespace', 'key', 'label'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const service = requireRegistry(opts.getSecretService, 'InlineSecretService');
        const namespace = getStringArg(args, 'namespace');
        const key = getStringArg(args, 'key');
        const label = getStringArg(args, 'label');
        const hint = getStringArg(args, 'hint', false) || undefined;
        const reason = getStringArg(args, 'reason', false) || undefined;
        const requestedBy = getStringArg(args, 'requestedBy', false) || undefined;
        const timeoutMs = getNumberArg(args, 'timeoutMs');
        const handle = service.requestSecret({
          namespace,
          key,
          label,
          ...(hint !== undefined ? { hint } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(requestedBy !== undefined ? { requestedBy } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (handle.fromVault) {
          return (
            `Secret "${label}" (${namespace}:${key}) đã có trong Vault — không cần hỏi user. ` +
            `Dùng secret_request_status với requestId ${JSON.stringify(handle.request.id)} để kiểm tra.`
          );
        }
        return JSON.stringify(handle.prompt, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const secretRequestStatusTool: Tool = {
    definition: {
      name: 'secret_request_status',
      description:
        'Kiểm tra trạng thái một yêu cầu secret inline (pending / fulfilled / declined / expired / cancelled). ' +
        'Chỉ trả trạng thái — KHÔNG BAO GIỜ trả giá trị secret. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: 'Id của yêu cầu (trả về bởi secret_request).',
          },
        },
        required: ['requestId'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const service = requireRegistry(opts.getSecretService, 'InlineSecretService');
        const requestId = getStringArg(args, 'requestId');
        const request = service.getRequest(requestId);
        if (!request) {
          return errorResult(`Không tìm thấy yêu cầu secret với id ${JSON.stringify(requestId)}.`);
        }
        const lines = [
          `Yêu cầu secret ${JSON.stringify(request.id)}: ${request.status}`,
          `Secret: ${request.label} (${request.namespace}:${request.key})`,
        ];
        if (request.requestedBy) lines.push(`Tool yêu cầu: ${request.requestedBy}`);
        if (request.finishReason) lines.push(`Lý do kết thúc: ${request.finishReason}`);
        if (request.status === 'fulfilled') {
          lines.push('Đã lưu vào Vault — tool cần secret có thể tiếp tục (giá trị không hiển thị ở đây).');
        } else if (request.status === 'pending') {
          lines.push('Đang chờ user trả lời trong chat.');
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    listDirectoryTool,
    showSkillTool,
    bundleInstallTool,
    bundleListTool,
    bundleToggleTool,
    hookConfigApplyTool,
    secretRequestTool,
    secretRequestStatusTool,
  ];
}

/**
 * Placeholder chưa bound (không có resolver — mỗi tool báo lỗi rõ
 * ràng cho tới khi host tạo lại bằng factory kèm resolver). Điều phối
 * viên nối factory vào defaultToolFactory, không dùng const này.
 */
export const SKILLS_PLUGINS_V107_TOOLS: Tool[] = createSkillsPluginsV107Tools();

/**
 * v1.07 (T4): activate one installed bundle through the tool layer —
 * thin wrapper over the core `activatePluginBundle` for hosts that
 * already hold the registries (the agent loop itself never calls
 * this directly; install is the tool, activation is the host's job
 * after install / at startup).
 */
export function activateInstalledBundle(
  bundleDir: string,
  deps: {
    skillRegistry?: SkillRegistry;
    hookRegistry?: HookRegistry;
    workspaceDir?: string;
    pluginsDir?: string;
  },
): ReturnType<typeof activatePluginBundle> {
  return activatePluginBundle(bundleDir, deps);
}
