/**
 * MCP Apps v2 + Tasks chuẩn 2026-07-28 — tool definitions cho agent
 * (v1.14, Đội T2).
 *
 * Đưa các module core v2 ra cho agent dùng như tool thường:
 *
 *   - `mcp_apps_v2_negotiate` — đàm phán capability hai chiều cho một
 *     server từ `server/discover` result (client + server đều khai báo
 *     extension thì mới bật; kèm fallback plan).
 *   - `mcp_apps_v2_gallery_list` — liệt kê template gallery
 *     (dashboard / form / chart / wizard) kèm schema input.
 *   - `mcp_apps_v2_gallery_render` — render một template với input cho
 *     trước thành component + HTML an toàn.
 *   - `mcp_apps_v2_bundle` — ghép HTML/CSS/JS thành một file app duy
 *     nhất + CSP header sinh tự động theo permissions.
 *   - `mcp_apps_v2_permissions_get` — xem quyền mic/camera của một app.
 *   - `mcp_apps_v2_permissions_set` — ghi quyết định quyền của user
 *     cho một app (nhớ hoặc chỉ trong phiên).
 *   - `mcp_apps_v2_permissions_revoke` — thu hồi quyền của một app.
 *   - `mcp_apps_v2_components_render` — render component kit v2
 *     (button / input / select / toggle / progress / badge / modal /
 *     toast / tabs) thành HTML an toàn.
 *
 * Toàn bộ chạy local, không gọi mạng ngoài, không cần key. Đổi quyền
 * mic/camera là thay đổi user nhìn thấy được nên cần approval; các tool
 * đọc / render / bundle thì không. Module này chỉ export mảng tool —
 * coordinator nối vào ALL_TOOLS sau (không sửa registry trung tâm ở đây).
 */

import type { Tool } from '@open-bot/core';
import {
  CapabilityNegotiatorV2,
  type ClientExtensionDeclaration,
} from '@open-bot/core/dist/mcp/capabilityNegotiationV2';
import {
  listGalleryTemplates,
  renderGalleryTemplate,
  summarizeGallery,
  type McpAppGalleryKind,
} from '@open-bot/core/dist/mcp/appsGalleryV2';
import { bundleMcpApp } from '@open-bot/core/dist/mcp/appsBundlerV2';
import {
  McpAppPermissionsV2,
  parseUiPermissions,
  type McpAppMediaPermission,
} from '@open-bot/core/dist/mcp/appsPermissionsV2';
import {
  renderAppComponentsV2,
  validateAppComponentV2,
  type AppComponentV2,
} from '@open-bot/core/dist/mcp/appsComponentsV2';
import { renderAppComponents } from '@open-bot/core/dist/mcp/appsComponents';

export const MCP_APPS_V2_TOOL_NAMES = [
  'mcp_apps_v2_negotiate',
  'mcp_apps_v2_gallery_list',
  'mcp_apps_v2_gallery_render',
  'mcp_apps_v2_bundle',
  'mcp_apps_v2_permissions_get',
  'mcp_apps_v2_permissions_set',
  'mcp_apps_v2_permissions_revoke',
  'mcp_apps_v2_components_render',
] as const;
export type McpAppsV2ToolName = (typeof MCP_APPS_V2_TOOL_NAMES)[number];

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Tool argument "${name}" must be an object.`);
}

function getArrayArg(args: Record<string, unknown>, name: string): unknown[] {
  const value = args[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw new Error(`Tool argument "${name}" must be an array.`);
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

/** Deps dùng chung cho 8 tool (mặc định: instance mới trong process). */
export interface McpAppsV2ToolsDeps {
  negotiator?: CapabilityNegotiatorV2;
  permissions?: McpAppPermissionsV2;
  userDataDir?: string;
}

/**
 * Tạo 8 tool v2. Không truyền deps thì dùng instance mặc định của module
 * (một instance cho toàn bộ process — quyền cấp bằng tool này thì tool
 * khác thấy được, khớp hành vi của `MCP_APPS_V113_TOOLS`).
 */
export function createMcpAppsV2Tools(deps: McpAppsV2ToolsDeps = {}): Tool[] {
  const negotiator = deps.negotiator ?? new CapabilityNegotiatorV2();
  const permissions =
    deps.permissions ?? new McpAppPermissionsV2({ userDataDir: deps.userDataDir });

  const negotiateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_negotiate',
      'Negotiate MCP Apps + Tasks capabilities two-way (spec 2026-07-28) for a server from its server/discover result: an extension is enabled only when BOTH client and server declare it. Returns effective apps/tasks levels, effective pieces, and fallback notes. Local only, no network.',
      {
        serverName: { type: 'string', description: 'Server name, e.g. my-server.' },
        clientApps: { type: 'boolean', description: 'Client declares MCP Apps (default true).' },
        clientTasks: { type: 'boolean', description: 'Client declares Tasks (default true).' },
        protocolVersion: { type: 'string', description: 'Negotiated protocol version (default 2026-07-28).' },
        discover: {
          type: 'object',
          description: 'server/discover result: { protocolVersion, capabilities, extensions, _meta }.',
        },
      },
      ['serverName'],
    ),
    needsApproval: false,
    async execute(args) {
      const serverName = getStringArg(args, 'serverName');
      const declaration: ClientExtensionDeclaration = {
        apps: getBoolArg(args, 'clientApps', true),
        tasks: getBoolArg(args, 'clientTasks', true),
      };
      const discover = getObjectArg(args, 'discover');
      const protocolVersion =
        getOptionalStringArg(args, 'protocolVersion') ??
        (typeof discover['protocolVersion'] === 'string'
          ? (discover['protocolVersion'] as string)
          : '2026-07-28');
      const record = negotiator.negotiateStateless(
        serverName,
        declaration,
        discover,
        protocolVersion,
      );
      return formatResult(record);
    },
  };

  const galleryListTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_gallery_list',
      'List MCP App gallery templates (dashboard, form, chart, wizard) with their input schemas and example inputs. Local only.',
      {
        kind: { type: 'string', enum: ['dashboard', 'form', 'chart', 'wizard'], description: 'Filter by template kind (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const kind = getOptionalStringArg(args, 'kind') as McpAppGalleryKind | undefined;
      if (kind) {
        return formatResult({ templates: listGalleryTemplates(kind), total: listGalleryTemplates(kind).length });
      }
      return formatResult({ templates: summarizeGallery(), total: 4 });
    },
  };

  const galleryRenderTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_gallery_render',
      'Render an MCP App gallery template with input data into safe HTML (validated against the template input schema first). Returns the component list and the rendered HTML. Local only.',
      {
        templateId: { type: 'string', description: 'Template id: dashboard, form, chart, or wizard.' },
        input: { type: 'object', description: 'Input data for the template (see gallery schema / exampleInput).' },
      },
      ['templateId', 'input'],
    ),
    needsApproval: false,
    async execute(args) {
      const templateId = getStringArg(args, 'templateId');
      const input = getObjectArg(args, 'input');
      const { template, components } = renderGalleryTemplate(templateId, input);
      const html = renderAppComponents(components);
      return formatResult({ templateId: template.id, kind: template.kind, components, html });
    },
  };

  const bundleTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_bundle',
      'Bundle HTML/CSS/JS into a single-file MCP App: CSS/JS are inlined, external references are stripped (with warnings), and a deny-by-default CSP header is generated from the app permissions. Local only.',
      {
        html: { type: 'string', description: 'Base HTML of the app.' },
        css: { type: 'array', items: { type: 'string' }, description: 'CSS chunks to inline (optional).' },
        js: { type: 'array', items: { type: 'string' }, description: 'JS chunks to inline (optional).' },
        allowedConnectHosts: { type: 'array', items: { type: 'string' }, description: 'Hosts the app may connect to (needs network permission).' },
        network: { type: 'boolean', description: 'App has network permission (default false).' },
        microphone: { type: 'boolean', description: 'App was granted microphone (default false).' },
        camera: { type: 'boolean', description: 'App was granted camera (default false).' },
      },
      ['html'],
    ),
    needsApproval: false,
    async execute(args) {
      const html = getStringArg(args, 'html');
      const css = getArrayArg(args, 'css').filter((c): c is string => typeof c === 'string');
      const js = getArrayArg(args, 'js').filter((j): j is string => typeof j === 'string');
      const hosts = getArrayArg(args, 'allowedConnectHosts').filter(
        (h): h is string => typeof h === 'string',
      );
      const bundle = bundleMcpApp({
        html,
        css,
        js,
        allowedConnectHosts: hosts,
        permissions: {
          network: getBoolArg(args, 'network', false),
          microphone: getBoolArg(args, 'microphone', false),
          camera: getBoolArg(args, 'camera', false),
        },
      });
      return formatResult(bundle);
    },
  };

  const permissionsGetTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_permissions_get',
      'Get the microphone/camera permission decisions for an MCP App (ui:// URI): granted, denied, or prompt (not decided yet). Local only.',
      {
        appUri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
      },
      ['appUri'],
    ),
    needsApproval: false,
    async execute(args) {
      const appUri = getStringArg(args, 'appUri');
      const records = permissions.permissionsForApp(appUri);
      const decisions = {
        microphone: permissions.check(appUri, 'microphone'),
        camera: permissions.check(appUri, 'camera'),
      };
      return formatResult({ appUri, decisions, records });
    },
  };

  const permissionsSetTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_permissions_set',
      'Record the user decision for an MCP App microphone/camera permission: granted or denied. remember=true persists the choice (app will not be asked again); false applies to this session only. Needs approval.',
      {
        appUri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
        permission: { type: 'string', enum: ['microphone', 'camera'], description: 'Permission kind.' },
        decision: { type: 'string', enum: ['granted', 'denied'], description: 'User decision.' },
        remember: { type: 'boolean', description: 'Remember this choice persistently (default false).' },
      },
      ['appUri', 'permission', 'decision'],
    ),
    needsApproval: true,
    async execute(args) {
      const appUri = getStringArg(args, 'appUri');
      const permission = getStringArg(args, 'permission') as McpAppMediaPermission;
      if (permission !== 'microphone' && permission !== 'camera') {
        throw new Error('Tool argument "permission" must be "microphone" or "camera".');
      }
      const decision = getStringArg(args, 'decision');
      if (decision !== 'granted' && decision !== 'denied') {
        throw new Error('Tool argument "decision" must be "granted" or "denied".');
      }
      const record = permissions.setDecision(appUri, permission, decision, {
        remember: getBoolArg(args, 'remember', false),
      });
      return formatResult({ ok: true, ...record });
    },
  };

  const permissionsRevokeTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_permissions_revoke',
      'Revoke microphone/camera permission(s) of an MCP App (one kind, or all when permission is omitted). The app will be asked again next time it needs the permission. Needs approval.',
      {
        appUri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
        permission: { type: 'string', enum: ['microphone', 'camera'], description: 'Permission kind to revoke (optional: revoke all).' },
      },
      ['appUri'],
    ),
    needsApproval: true,
    async execute(args) {
      const appUri = getStringArg(args, 'appUri');
      const permission = getOptionalStringArg(args, 'permission') as McpAppMediaPermission | undefined;
      if (permission !== undefined && permission !== 'microphone' && permission !== 'camera') {
        throw new Error('Tool argument "permission" must be "microphone" or "camera".');
      }
      const removed = permissions.revoke(appUri, permission);
      return formatResult({ ok: true, appUri, revoked: removed });
    },
  };

  const componentsRenderTool: Tool = {
    definition: toolDef(
      'mcp_apps_v2_components_render',
      'Render MCP App v2 components (button, textInput, select, toggle, progressBar, badge, modal, toast, tabs) into safe HTML with the shared kit CSS. Each component is validated first. Local only.',
      {
        components: {
          type: 'array',
          items: { type: 'object' },
          description: 'List of v2 components to render (max 100).',
        },
        includeCss: { type: 'boolean', description: 'Include the shared kit CSS (default true).' },
      },
      ['components'],
    ),
    needsApproval: false,
    async execute(args) {
      const raw = getArrayArg(args, 'components');
      const errors: string[] = [];
      raw.forEach((c, i) => {
        const errs = validateAppComponentV2(c);
        if (errs.length > 0) errors.push(`components[${i}]: ${errs.join('; ')}`);
      });
      if (errors.length > 0) {
        throw new Error(`Invalid v2 components: ${errors.join(' | ')}`);
      }
      const html = renderAppComponentsV2(raw as AppComponentV2[], {
        includeCss: getBoolArg(args, 'includeCss', true),
      });
      return formatResult({ ok: true, count: raw.length, html });
    },
  };

  return [
    negotiateTool,
    galleryListTool,
    galleryRenderTool,
    bundleTool,
    permissionsGetTool,
    permissionsSetTool,
    permissionsRevokeTool,
    componentsRenderTool,
  ];
}

export const MCP_APPS_V2_TOOLS: Tool[] = createMcpAppsV2Tools();

/** Parse `_meta.ui.permissions` — re-export tiện cho caller dùng tool. */
export { parseUiPermissions };
