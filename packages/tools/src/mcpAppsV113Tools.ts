/**
 * MCP Apps host v13 — tool definitions cho agent (v1.13, Team T2).
 *
 * Đưa host v13 ra cho agent dùng như tool thường (không cần chạm code):
 *
 *   - `mcp_apps_ui_register` — đăng ký resource app vào registry `ui://`
 *     (URI + HTML đã validate + MIME `text/html;profile=mcp-app`).
 *   - `mcp_apps_ui_list` — liệt kê resource app đã đăng ký (snapshot, không lộ HTML).
 *   - `mcp_apps_ui_open` — mở app từ registry theo URI `ui://`, chọn
 *     display mode (inline / fullscreen / pip); trả frame config + session id.
 *   - `mcp_apps_ui_set_display_mode` — đổi display mode của app đang mở
 *     (kèm di chuyển / đổi kích thước cửa sổ pip).
 *   - `mcp_apps_ui_model_context` — đẩy model context mới xuống app đang mở
 *     (host trả notification `ui/model-context-updated` cho renderer).
 *   - `mcp_apps_components_render` — render danh sách component khai báo
 *     (card / table / metric / form / list / chart-placeholder) thành HTML
 *     an toàn, kèm kiểm tra qua `validateAppHtml`.
 *   - `mcp_apps_ui_sample` — mở một trong 4 sample app của host v13
 *     (dashboard / form / monitor / table) để kiểm tra sandbox + dialect.
 *
 * Toàn bộ chạy local, không gọi mạng ngoài, không cần key. Mở app /
 * đổi display mode là thay đổi UI nhìn thấy được nên cần approval;
 * đọc registry và render component thì không. Module này chỉ export
 * mảng tool — coordinator nối vào ALL_TOOLS sau (không sửa registry
 * trung tâm ở đây).
 */

import type { Tool } from '@open-bot/core';
import {
  McpAppHostV13,
  MCP_APP_V13_SAMPLE_KINDS,
  type McpAppV13SampleKind,
} from '@open-bot/core/dist/mcp/appsHostV13';
import {
  renderAppComponents,
  validateAppComponent,
  type AppComponent,
} from '@open-bot/core/dist/mcp/appsComponents';
import { validateAppHtml } from '@open-bot/core/dist/mcp/apps';
import { parseDisplayMode } from '@open-bot/core/dist/mcp/appsDisplayModes';
import { parseUiResourceUri } from '@open-bot/core/dist/mcp/appsUiMeta';

export const MCP_APPS_V113_TOOL_NAMES = [
  'mcp_apps_ui_register',
  'mcp_apps_ui_list',
  'mcp_apps_ui_open',
  'mcp_apps_ui_set_display_mode',
  'mcp_apps_ui_model_context',
  'mcp_apps_components_render',
  'mcp_apps_ui_sample',
] as const;
export type McpAppsV113ToolName = (typeof MCP_APPS_V113_TOOL_NAMES)[number];

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

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Tool argument "${name}" must be an object.`);
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function openedAppSummary(opened: ReturnType<McpAppHostV13['openAppFromRegistry']>): Record<string, unknown> {
  return {
    ok: true,
    appId: opened.appId,
    dialectSessionId: opened.dialectSessionId,
    ...(opened.bridgeSessionId ? { bridgeSessionId: opened.bridgeSessionId } : {}),
    uri: opened.uri,
    title: opened.title,
    serverName: opened.serverName,
    ...(opened.toolName ? { toolName: opened.toolName } : {}),
    displayMode: opened.displayMode,
    pip: opened.displayState.pip,
    sandbox: opened.frameConfig.sandbox,
    csp: opened.frameConfig.csp,
    hostContext: opened.hostContext,
  };
}

/**
 * Tạo 7 tool v13 trên một host instance. Không truyền host thì dùng
 * host mặc định của module (một instance cho toàn bộ process — app
 * mở bằng tool này thì tool khác thấy được, khớp hành vi của
 * `MCP_V110_TOOLS`).
 */
export function createMcpAppsV113Tools(host: McpAppHostV13 = new McpAppHostV13()): Tool[] {
  const registerTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_register',
      'Register an MCP App resource in the ui:// registry: validate the HTML, store it under its ui:// URI (MIME text/html or text/html;profile=mcp-app) so it can be opened later with mcp_apps_ui_open. Re-registering the same URI updates the app. Local only, no network.',
      {
        uri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
        html: { type: 'string', description: 'Self-contained HTML of the app (validated: no remote scripts, no storage, no parent access).' },
        title: { type: 'string', description: 'Display title (defaults to the last path segment of the URI).' },
        toolName: { type: 'string', description: 'Name of the tool that produced the app (for resolveForTool).' },
        mimeType: { type: 'string', description: 'MIME type: text/html or text/html;profile=mcp-app (default).' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Suggested display mode.' },
        ttlMs: { type: 'number', description: 'Optional TTL in milliseconds; expired entries are pruned.' },
      },
      ['uri', 'html'],
    ),
    needsApproval: false,
    async execute(args) {
      const uri = getStringArg(args, 'uri');
      const html = getStringArg(args, 'html');
      const parsed = parseUiResourceUri(uri);
      const entry = host.registry.register({
        uri: parsed.uri,
        serverName: parsed.server,
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
        html,
        mimeType: getOptionalStringArg(args, 'mimeType') ?? 'text/html;profile=mcp-app',
        ...(getOptionalStringArg(args, 'displayMode')
          ? { displayMode: parseDisplayMode(getOptionalStringArg(args, 'displayMode')) }
          : {}),
        ...(typeof args['ttlMs'] === 'number' ? { ttlMs: args['ttlMs'] } : {}),
      });
      return formatResult({
        ok: true,
        uri: entry.uri,
        serverName: entry.serverName,
        title: entry.title,
        mimeType: entry.mimeType,
        version: entry.version,
        sizeBytes: entry.sizeBytes,
      });
    },
  };

  const listTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_list',
      'List MCP App resources registered in the ui:// registry (light snapshots without HTML). Optionally filter by server or tool. Also reports registry stats and currently open apps.',
      {
        serverName: { type: 'string', description: 'Only entries from this MCP server.' },
        toolName: { type: 'string', description: 'Only entries produced by this tool.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const entries = host.registry.list({
        ...(getOptionalStringArg(args, 'serverName') ? { serverName: getOptionalStringArg(args, 'serverName') } : {}),
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
      });
      return formatResult({
        ok: true,
        entries,
        stats: host.registry.stats(),
        openApps: host.listApps(),
      });
    },
  };

  const openTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_open',
      'Open a registered MCP App by its ui:// URI in the desktop app (sandboxed iframe, CSP deny by default). Choose a display mode: inline (in the chat flow), fullscreen (editor/dashboard), or pip (floating monitor/timer window). Returns the app id, dialect session id and frame config for the renderer.',
      {
        uri: { type: 'string', description: 'App resource URI in the registry, e.g. ui://my-server/dashboard.' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Display mode (default: the mode suggested at registration, else inline).' },
        title: { type: 'string', description: 'Title override.' },
        allowOpenLink: { type: 'boolean', description: 'Allow the app to open http(s) links via the host (default false).' },
      },
      ['uri'],
    ),
    needsApproval: true,
    async execute(args) {
      const opened = host.openAppFromRegistry(getStringArg(args, 'uri'), {
        ...(getOptionalStringArg(args, 'displayMode')
          ? { displayMode: parseDisplayMode(getOptionalStringArg(args, 'displayMode')) }
          : {}),
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
        ...(typeof args['allowOpenLink'] === 'boolean' ? { allowOpenLink: args['allowOpenLink'] } : {}),
      });
      return formatResult(openedAppSummary(opened));
    },
  };

  const setDisplayModeTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_set_display_mode',
      'Change the display mode of an open MCP App (inline / fullscreen / pip). For pip, optionally move or resize the floating window (x, y, width, height in px, clamped to the viewport). Only one app can be fullscreen at a time.',
      {
        appId: { type: 'string', description: 'App id from mcp_apps_ui_open / mcp_apps_ui_sample.' },
        mode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'New display mode.' },
        x: { type: 'number', description: 'Pip window left (px).' },
        y: { type: 'number', description: 'Pip window top (px).' },
        width: { type: 'number', description: 'Pip window width (px, 240..960).' },
        height: { type: 'number', description: 'Pip window height (px, 160..720).' },
      },
      ['appId', 'mode'],
    ),
    needsApproval: true,
    async execute(args) {
      const appId = getStringArg(args, 'appId');
      const mode = parseDisplayMode(getStringArg(args, 'mode'));
      let state = host.setDisplayMode(appId, mode);
      if (mode === 'pip') {
        if (typeof args['x'] === 'number' && typeof args['y'] === 'number') {
          state = host.displayModes.movePip(appId, args['x'], args['y']);
        }
        if (typeof args['width'] === 'number' && typeof args['height'] === 'number') {
          state = host.displayModes.resizePip(appId, args['width'], args['height']);
        }
      }
      return formatResult({ ok: true, appId, mode: state.mode, pip: state.pip, previousMode: state.previousMode });
    },
  };

  const modelContextTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_model_context',
      'Push new model context down to an open MCP App (ui/model-context-updated notification over the ui/ JSON-RPC dialect). The app updates what it shows without reloading. Returns the notification object the renderer posts into the iframe.',
      {
        appId: { type: 'string', description: 'App id from mcp_apps_ui_open / mcp_apps_ui_sample.' },
        context: { type: 'object', description: 'Model context object, e.g. {"taskStatus":"working","progress":42,"data":{...}}.' },
      },
      ['appId', 'context'],
    ),
    needsApproval: false,
    async execute(args) {
      const appId = getStringArg(args, 'appId');
      const context = getObjectArg(args, 'context');
      const notification = host.updateModelContext(appId, context);
      if (!notification) {
        throw new Error(`No open app "${appId}" (or its dialect session is gone).`);
      }
      return formatResult({ ok: true, notification });
    },
  };

  const componentsRenderTool: Tool = {
    definition: toolDef(
      'mcp_apps_components_render',
      'Render a list of declarative MCP App components (card, table, metric, form, list, chart-placeholder, stack, grid) into safe, self-contained HTML using the v13 component kit. Validates every component first and checks the result with validateAppHtml. Use it to build simple apps without hand-writing HTML; complex apps should use the html escape hatch via mcp_apps_ui_register instead.',
      {
        components: { type: 'array', description: 'Array of component objects, e.g. [{"type":"metric","label":"Users","value":128}].' },
        title: { type: 'string', description: 'Title of the generated HTML document.' },
        theme: { type: 'string', enum: ['light', 'dark'], description: 'Theme for the generated app (default light).' },
      },
      ['components'],
    ),
    needsApproval: false,
    async execute(args) {
      const raw = args['components'];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('Tool argument "components" must be a non-empty array of component objects.');
      }
      const errors: string[] = [];
      for (const component of raw) {
        errors.push(...validateAppComponent(component));
      }
      if (errors.length > 0) {
        throw new Error(`Component không hợp lệ: ${errors.join('; ')}`);
      }
      const html = renderAppComponents(raw as AppComponent[], {
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
        ...(getOptionalStringArg(args, 'theme') === 'dark' ? { theme: 'dark' as const } : {}),
      });
      const validation = validateAppHtml(html);
      return formatResult({
        ok: true,
        valid: validation.valid,
        findings: validation.findings,
        htmlBytes: new TextEncoder().encode(html).length,
        html,
      });
    },
  };

  const sampleTool: Tool = {
    definition: toolDef(
      'mcp_apps_ui_sample',
      'Open one of the four built-in sample MCP Apps (dashboard, form, monitor, table) built with the v13 component kit — no MCP server needed. Use it to check the sandbox, the ui/ dialect and the display modes. The monitor sample opens in pip mode by default.',
      {
        kind: { type: 'string', enum: [...MCP_APP_V13_SAMPLE_KINDS], description: 'Sample app kind.' },
      },
      ['kind'],
    ),
    needsApproval: true,
    async execute(args) {
      const kind = getStringArg(args, 'kind') as McpAppV13SampleKind;
      if (!(MCP_APP_V13_SAMPLE_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`Sample kind phải là một trong: ${MCP_APP_V13_SAMPLE_KINDS.join(', ')}.`);
      }
      const opened = host.openSampleApp(kind);
      return formatResult(openedAppSummary(opened));
    },
  };

  return [
    registerTool,
    listTool,
    openTool,
    setDisplayModeTool,
    modelContextTool,
    componentsRenderTool,
    sampleTool,
  ];
}

/** Unbound placeholders (same pattern as MCP_TOOLS / MCP_V110_TOOLS). */
export const MCP_APPS_V113_TOOLS: Tool[] = createMcpAppsV113Tools();
