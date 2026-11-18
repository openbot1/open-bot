/**
 * MCP Apps host v15 — tool definitions cho agent (v1.35, Đội T3).
 *
 * Đưa host v15 ra cho agent dùng như tool thường (không cần chạm code):
 *
 *   - `mcp_apps_v15_register` — đăng ký resource app vào registry
 *     `ui://` (HTML document đầy đủ đã validate + MIME BẮT BUỘC
 *     `text/html;profile=mcp-app`).
 *   - `mcp_apps_v15_manifest` — đăng ký app manifest v15 (tên,
 *     version semver, capabilities, sandbox/CSP profile).
 *   - `mcp_apps_v15_declare_tool_ui` — khai báo `_meta.ui` cho một
 *     tool + text fallback BẮT BUỘC.
 *   - `mcp_apps_v15_open` — mở app cho một client (negotiation
 *     ui/text + auto-visualiser đính kèm).
 *   - `mcp_apps_v15_bridge_message` — xử lý một message postMessage
 *     JSON-RPC 2.0 từ app (ui/initialize, tools/call, resources/read,
 *     ui/open-link, ui/post-message, ...).
 *   - `mcp_apps_v15_consent` — liệt kê consent đang chờ / duyệt /
 *     từ chối action do UI khởi xướng.
 *   - `mcp_apps_v15_visualise` — auto-visualiser: tự sinh
 *     chart/sankey/mermaid/map/table từ dữ liệu + text fallback.
 *   - `mcp_apps_v15_skill_create` — tạo Agent Skill mới chuyên tạo
 *     MCP App (SKILL.md + app mẫu).
 *   - `mcp_apps_v15_skill_add` — thêm app mới vào skill đã có.
 *   - `mcp_apps_v15_skill_migrate` — migrate app v13/v14 lên v15.
 *   - `mcp_apps_v15_audit` — liệt kê audit log (host + consent) và
 *     kiểm chứng hash chain.
 *
 * Toàn bộ chạy local, không gọi mạng ngoài, không cần key. Mở app
 * và quyết định consent là thay đổi nhìn thấy được / có hệ quả nên
 * cần approval; đọc registry, negotiation, visualise, skill, audit
 * thì không. Module này chỉ export mảng tool — coordinator nối vào
 * ALL_TOOLS sau (không sửa registry trung tâm ở đây).
 */

import type { Tool } from '@open-bot/core';
import {
  McpAppHostV15,
  MCP_APPS_V15_VERSION,
  parseV14ClientCapability,
  type V14ClientAppsCapability,
} from '@open-bot/core/dist/mcp/appsHostV15';
import {
  createAppSkill,
  addAppToSkill,
  migrateAppToV15,
  scaffoldApp,
  type UiV15AppTemplate,
} from '@open-bot/core/dist/mcp/appsSkillsV15';
import { visualiseData, type UiV15VisualisationKind } from '@open-bot/core/dist/mcp/appsVisualiserV15';

export const MCP_APPS_V15_TOOL_NAMES = [
  'mcp_apps_v15_register',
  'mcp_apps_v15_manifest',
  'mcp_apps_v15_declare_tool_ui',
  'mcp_apps_v15_open',
  'mcp_apps_v15_bridge_message',
  'mcp_apps_v15_consent',
  'mcp_apps_v15_visualise',
  'mcp_apps_v15_skill_create',
  'mcp_apps_v15_skill_add',
  'mcp_apps_v15_skill_migrate',
  'mcp_apps_v15_audit',
] as const;
export type McpAppsV15ToolName = (typeof MCP_APPS_V15_TOOL_NAMES)[number];

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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Tool argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

/** Parse capability client từ argument tool. */
function parseClientArg(args: Record<string, unknown>): V14ClientAppsCapability {
  const supportsApps = args['clientSupportsApps'] === true;
  const renderModes = getStringArrayArg(args, 'renderModes') ?? [];
  const maxWidthPx = typeof args['maxWidthPx'] === 'number' ? args['maxWidthPx'] : undefined;
  const maxHeightPx = typeof args['maxHeightPx'] === 'number' ? args['maxHeightPx'] : undefined;
  return parseV14ClientCapability({
    capabilities: {
      apps: {
        supportsApps,
        ...(renderModes.length > 0 ? { renderModes } : {}),
        ...(maxWidthPx !== undefined ? { maxWidthPx } : {}),
        ...(maxHeightPx !== undefined ? { maxHeightPx } : {}),
      },
    },
  });
}

/**
 * Tạo 11 tool v15 trên một host instance. Không truyền host thì dùng
 * host mặc định của module (một instance cho toàn bộ process — app
 * mở bằng tool này thì tool khác thấy được, khớp hành vi của
 * `MCP_APPS_V14_TOOLS`).
 */
export function createMcpAppsV15Tools(host: McpAppHostV15 = new McpAppHostV15()): Tool[] {
  const registerTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_register',
      'Register an MCP App resource in the ui:// registry (v15): validate the HTML document (full <!doctype html> document only, no <base href>/<form action> to outside) and REQUIRE the MIME text/html;profile=mcp-app (plain text/html is rejected). Local only, no network.',
      {
        uri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
        html: { type: 'string', description: 'Full HTML document of the app (must start with <!doctype html>).' },
        title: { type: 'string', description: 'Display title (defaults to the last path segment of the URI).' },
        toolName: { type: 'string', description: 'Name of the tool that produced the app.' },
        mimeType: { type: 'string', description: 'MIME type — must be text/html;profile=mcp-app (default).' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Suggested display mode.' },
        ttlMs: { type: 'number', description: 'Optional TTL in milliseconds; expired entries are pruned.' },
      },
      ['uri', 'html'],
    ),
    needsApproval: false,
    async execute(args) {
      const uri = getStringArg(args, 'uri');
      const html = getStringArg(args, 'html');
      const entry = host.registry.registerResource({
        uri,
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
        html,
        mimeType: getOptionalStringArg(args, 'mimeType') ?? 'text/html;profile=mcp-app',
        ...(getOptionalStringArg(args, 'displayMode')
          ? { displayMode: getOptionalStringArg(args, 'displayMode') as 'inline' | 'fullscreen' | 'pip' }
          : {}),
        ...(typeof args['ttlMs'] === 'number' ? { ttlMs: args['ttlMs'] } : {}),
      });
      return formatResult({
        ok: true,
        version: MCP_APPS_V15_VERSION,
        uri: entry.uri,
        serverName: entry.serverName,
        title: entry.title,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
      });
    },
  };

  const manifestTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_manifest',
      'Register an MCP App v15 manifest for an already-registered ui:// resource: name (kebab-case, must match the URI tail), semver version, capabilities the app requests, sandbox profile (display-only/interactive/privileged) and CSP profile (strict/media/network). Rejected when the resource is not registered yet or the manifest is invalid. Local only.',
      {
        name: { type: 'string', description: 'App name in kebab-case, e.g. dashboard (must match the URI tail).' },
        version: { type: 'string', description: 'App version as semver, e.g. 1.2.0.' },
        server: { type: 'string', description: 'Server owning the app, e.g. my-server.' },
        resourceUri: { type: 'string', description: 'ui:// resource URI of the app (must already be registered).' },
        description: { type: 'string', description: 'Short description of the app (max 500 chars).' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities the app requests: tools-call, resources-read, open-link, post-message, model-context, display-mode, clipboard-write, media-microphone, media-camera.' },
        sandboxProfile: { type: 'string', enum: ['display-only', 'interactive', 'privileged'], description: 'Sandbox profile (default display-only).' },
        cspProfile: { type: 'string', enum: ['strict', 'media', 'network'], description: 'CSP profile (default strict).' },
        toolName: { type: 'string', description: 'Tool that produced the app.' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Suggested display mode.' },
        author: { type: 'string', description: 'App author (display only).' },
      },
      ['name', 'version', 'server', 'resourceUri'],
    ),
    needsApproval: false,
    async execute(args) {
      const { manifest, warnings } = host.registry.registerManifest({
        name: getStringArg(args, 'name'),
        version: getStringArg(args, 'version'),
        server: getStringArg(args, 'server'),
        resourceUri: getStringArg(args, 'resourceUri'),
        ...(getOptionalStringArg(args, 'description') ? { description: getOptionalStringArg(args, 'description') } : {}),
        ...(getStringArrayArg(args, 'capabilities') ? { capabilities: getStringArrayArg(args, 'capabilities') } : {}),
        ...(getOptionalStringArg(args, 'sandboxProfile') ? { sandboxProfile: getOptionalStringArg(args, 'sandboxProfile') } : {}),
        ...(getOptionalStringArg(args, 'cspProfile') ? { cspProfile: getOptionalStringArg(args, 'cspProfile') } : {}),
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
        ...(getOptionalStringArg(args, 'displayMode') ? { displayMode: getOptionalStringArg(args, 'displayMode') } : {}),
        ...(getOptionalStringArg(args, 'author') ? { author: getOptionalStringArg(args, 'author') } : {}),
      });
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, manifest, warnings });
    },
  };

  const declareTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_declare_tool_ui',
      'Declare the UI of a tool via _meta.ui (v15): the tool points at an already-registered ui:// resource and MUST provide a full text fallback for clients that cannot render apps (terminal). Rejected when the resource is not registered yet or the fallback is missing/too short. Local only.',
      {
        toolName: { type: 'string', description: 'Name of the tool that has a UI.' },
        resourceUri: { type: 'string', description: 'ui:// resource URI of the app (must already be registered).' },
        textFallback: { type: 'string', description: 'Full text equivalent of what the UI shows (min 20 chars).' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Suggested display mode.' },
        title: { type: 'string', description: 'Suggested title for the app.' },
        serverName: { type: 'string', description: 'MCP server owning the tool (must match the resource server).' },
      },
      ['toolName', 'resourceUri', 'textFallback'],
    ),
    needsApproval: false,
    async execute(args) {
      const toolName = getStringArg(args, 'toolName');
      const resourceUri = getStringArg(args, 'resourceUri');
      const textFallback = getStringArg(args, 'textFallback');
      const uiMeta: Record<string, unknown> = { resourceUri };
      const displayMode = getOptionalStringArg(args, 'displayMode');
      if (displayMode) uiMeta['displayMode'] = displayMode;
      const title = getOptionalStringArg(args, 'title');
      if (title) uiMeta['title'] = title;
      const registration = host.registry.declareToolUi(toolName, uiMeta, {
        textFallback,
        ...(getOptionalStringArg(args, 'serverName') ? { serverName: getOptionalStringArg(args, 'serverName') } : {}),
      });
      return formatResult({
        ok: true,
        version: MCP_APPS_V15_VERSION,
        toolName: registration.toolName,
        serverName: registration.serverName,
        resourceUri: registration.declaration.resourceUri,
        appName: registration.declaration.appName,
        hasManifest: registration.manifest !== undefined,
        warnings: registration.warnings,
        fallbackChars: registration.textFallback.charCount,
      });
    },
  };

  const openTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_open',
      'Open a registered MCP App for a client (v15): negotiates UI vs text fallback from the client capability, checks the v15 open policy (manifest), creates a bridge v15 session, and attaches an auto-visualisation when the tool result holds structured data. Returns the bridge session id + host context (UI mode) or the full text fallback (text mode). Needs approval because opening an app is user-visible.',
      {
        toolName: { type: 'string', description: 'Name of the tool that has a UI.' },
        toolResult: { type: 'object', description: 'The tools/call result of the tool (content blocks with text fallback).' },
        clientSupportsApps: { type: 'boolean', description: 'Client can render MCP Apps (default false = text mode).' },
        renderModes: { type: 'array', items: { type: 'string' }, description: 'Render modes the client supports (inline/fullscreen/pip).' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Display mode to open the app in.' },
        allowOpenLink: { type: 'boolean', description: 'Allow the app to open external links (default false).' },
        allowPostMessage: { type: 'boolean', description: 'Allow the app to post messages into the chat (default false).' },
        autoApproveReadOnlyTools: { type: 'array', items: { type: 'string' }, description: 'Read-only tools the app may call without asking (auto-approve list).' },
        autoVisualise: { type: 'boolean', description: 'Attach an auto-visualisation when the result holds structured data (default true).' },
        locale: { type: 'string', description: 'Locale for the host context, e.g. vi (default en).' },
        timezone: { type: 'string', description: 'IANA timezone for the host context, e.g. Asia/Ho_Chi_Minh.' },
      },
      ['toolName', 'toolResult'],
    ),
    needsApproval: true,
    async execute(args) {
      const toolName = getStringArg(args, 'toolName');
      const toolResult = getObjectArg(args, 'toolResult');
      const client = parseClientArg(args);
      const registration = host.registry.getToolUi(toolName);
      if (!registration) {
        throw new Error(`Tool "${toolName}" has no UI registered in the v15 registry — register the resource and declare _meta.ui first.`);
      }
      const result = host.openAppForClient(
        {
          name: toolName,
          _meta: {
            ui: {
              resourceUri: registration.declaration.resourceUri,
              ...(registration.declaration.displayMode ? { displayMode: registration.declaration.displayMode } : {}),
            },
          },
        },
        toolResult,
        client,
        {
          ...(getOptionalStringArg(args, 'displayMode')
            ? { displayMode: getOptionalStringArg(args, 'displayMode') as 'inline' | 'fullscreen' | 'pip' }
            : {}),
          allowOpenLink: getBoolArg(args, 'allowOpenLink', false),
          allowPostMessage: getBoolArg(args, 'allowPostMessage', false),
          ...(getStringArrayArg(args, 'autoApproveReadOnlyTools')
            ? { autoApproveReadOnlyTools: getStringArrayArg(args, 'autoApproveReadOnlyTools') }
            : {}),
          autoVisualise: getBoolArg(args, 'autoVisualise', true),
          ...(getOptionalStringArg(args, 'locale') ? { locale: getOptionalStringArg(args, 'locale') } : {}),
          ...(getOptionalStringArg(args, 'timezone') ? { timezone: getOptionalStringArg(args, 'timezone') } : {}),
        },
      );
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, ...result });
    },
  };

  const bridgeMessageTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_bridge_message',
      'Handle one postMessage JSON-RPC 2.0 message from an MCP App in its sandboxed iframe (v15): ui/initialize, tools/call (consent-gated), tools/list, resources/read, resources/list, ui/open-link, ui/post-message, ui/message, ui/close. Returns the JSON-RPC response the renderer posts back to the iframe (null for notifications). Local only.',
      {
        sessionId: { type: 'string', description: 'Bridge v15 session id returned by mcp_apps_v15_open.' },
        message: { type: 'object', description: 'The JSON-RPC 2.0 message object from the app ({ jsonrpc: "2.0", method, params, id }).' },
        origin: { type: 'string', description: 'postMessage event.origin (default "null" for srcdoc iframes).' },
      },
      ['sessionId', 'message'],
    ),
    needsApproval: false,
    async execute(args) {
      const sessionId = getStringArg(args, 'sessionId');
      const message = getObjectArg(args, 'message');
      const origin = getOptionalStringArg(args, 'origin') ?? 'null';
      const response = await host.handleBridgeMessage(sessionId, message, origin);
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, response });
    },
  };

  const consentTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_consent',
      'Manage consent for UI-initiated actions (v15): list pending consent requests from apps, or approve/deny one. The UI is untrusted code — a side-effect tool call from an app runs only after the user approves its consent (sensitive actions are one-shot). Approving/denying needs approval.',
      {
        action: { type: 'string', enum: ['list', 'approve', 'deny'], description: 'Action: list pending consents, approve one, or deny one.' },
        consentId: { type: 'string', description: 'Consent id to approve/deny (required for approve/deny).' },
        appUri: { type: 'string', description: 'Filter pending consents by app URI (list only).' },
        sessionId: { type: 'string', description: 'Filter pending consents by bridge session (list only).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      const action = getStringArg(args, 'action');
      if (action === 'list') {
        const pending = host.listPendingConsents({
          ...(getOptionalStringArg(args, 'appUri') ? { appUri: getOptionalStringArg(args, 'appUri') } : {}),
          ...(getOptionalStringArg(args, 'sessionId') ? { sessionId: getOptionalStringArg(args, 'sessionId') } : {}),
        });
        return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, pending, total: pending.length });
      }
      if (action === 'approve' || action === 'deny') {
        const consentId = getStringArg(args, 'consentId');
        const response = await host.decideConsent(consentId, action === 'approve' ? 'approved' : 'denied');
        return formatResult({
          ok: true,
          version: MCP_APPS_V15_VERSION,
          consentId,
          decision: action === 'approve' ? 'approved' : 'denied',
          bridgeResponse: response,
        });
      }
      throw new Error('Tool argument "action" must be "list", "approve", or "deny".');
    },
  };

  const visualiseTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_visualise',
      'Auto-visualise structured data (v15): detect the best visualisation (bar/line/pie chart, sankey flow, mermaid flowchart, map, or table) and return its spec + safe HTML (inline SVG, no scripts) + full text fallback. Data that cannot be drawn returns kind "none" with a JSON text fallback instead of an error. Local only.',
      {
        data: { type: 'object', description: 'Structured data to visualise: array of { label, value }, { from, to, value } edges, { lat, lng } points, { nodes, edges }, or rows.' },
        title: { type: 'string', description: 'Title of the visualisation.' },
        forceKind: { type: 'string', enum: ['bar-chart', 'line-chart', 'pie-chart', 'sankey', 'mermaid-flow', 'map', 'table', 'none'], description: 'Force a visualisation kind instead of auto-detecting.' },
      },
      ['data'],
    ),
    needsApproval: false,
    async execute(args) {
      const data = args['data'];
      if (data === undefined) throw new Error('Tool argument "data" is required.');
      const title = getOptionalStringArg(args, 'title');
      const forceKind = getOptionalStringArg(args, 'forceKind') as UiV15VisualisationKind | undefined;
      const result = visualiseData(data, {
        ...(title ? { title } : {}),
        ...(forceKind ? { forceKind } : {}),
      });
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, ...result });
    },
  };

  const skillCreateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_skill_create',
      'Create a new Agent Skill that builds MCP Apps (v15): generates SKILL.md + skill.json + a sample app from a template (dashboard/form/chart/wizard/blank), and registers the skill on the host so mcp_apps_v15_skill_add can use it. Returns the generated files (path + content) — the caller writes them to disk. Local only.',
      {
        name: { type: 'string', description: 'Skill name in kebab-case, e.g. sales-dashboard-apps.' },
        description: { type: 'string', description: 'What the skill builds, for whom (min 20 chars).' },
        version: { type: 'string', description: 'Skill version as semver (default 1.0.0).' },
        defaultTemplate: { type: 'string', enum: ['dashboard', 'form', 'chart', 'wizard', 'blank'], description: 'Default app template for this skill (default dashboard).' },
        defaultServer: { type: 'string', description: 'Default server apps register into (default local-apps).' },
        author: { type: 'string', description: 'Skill author.' },
        sampleAppName: { type: 'string', description: 'Name of the sample app (default: same as the skill name).' },
      },
      ['name', 'description'],
    ),
    needsApproval: false,
    async execute(args) {
      const skill = createAppSkill({
        name: getStringArg(args, 'name'),
        description: getStringArg(args, 'description'),
        ...(getOptionalStringArg(args, 'version') ? { version: getOptionalStringArg(args, 'version') } : {}),
        ...(getOptionalStringArg(args, 'defaultTemplate')
          ? { defaultTemplate: getOptionalStringArg(args, 'defaultTemplate') as UiV15AppTemplate }
          : {}),
        ...(getOptionalStringArg(args, 'defaultServer') ? { defaultServer: getOptionalStringArg(args, 'defaultServer') } : {}),
        ...(getOptionalStringArg(args, 'author') ? { author: getOptionalStringArg(args, 'author') } : {}),
        ...(getOptionalStringArg(args, 'sampleAppName') ? { sampleAppName: getOptionalStringArg(args, 'sampleAppName') } : {}),
      });
      host.skills.register(skill);
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, manifest: skill.manifest, skillMd: skill.skillMd, files: skill.files });
    },
  };

  const skillAddTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_skill_add',
      'Add a new app to an already-registered Agent Skill (v15): scaffolds the app from a template (or the skill default) and updates the skill manifest + SKILL.md. Rejected when the skill is not registered or the app name already exists in it. Local only.',
      {
        skillName: { type: 'string', description: 'Name of the registered skill to add the app to.' },
        appName: { type: 'string', description: 'New app name in kebab-case.' },
        serverName: { type: 'string', description: 'Server the app registers into (default: the skill default server).' },
        template: { type: 'string', enum: ['dashboard', 'form', 'chart', 'wizard', 'blank'], description: 'App template (default: the skill default template).' },
        title: { type: 'string', description: 'Display title of the app.' },
        description: { type: 'string', description: 'Short description of the app.' },
        version: { type: 'string', description: 'App version as semver (default 1.0.0).' },
        toolName: { type: 'string', description: 'Tool that produced the app.' },
        author: { type: 'string', description: 'App author.' },
      },
      ['skillName', 'appName'],
    ),
    needsApproval: false,
    async execute(args) {
      const skillName = getStringArg(args, 'skillName');
      const skill = host.skills.get(skillName);
      if (!skill) {
        throw new Error(`Skill "${skillName}" is not registered — create it with mcp_apps_v15_skill_create first.`);
      }
      const { skill: updated, app } = addAppToSkill(skill, {
        appName: getStringArg(args, 'appName'),
        serverName: getOptionalStringArg(args, 'serverName') ?? skill.manifest.defaultServer,
        ...(getOptionalStringArg(args, 'template')
          ? { template: getOptionalStringArg(args, 'template') as UiV15AppTemplate }
          : {}),
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
        ...(getOptionalStringArg(args, 'description') ? { description: getOptionalStringArg(args, 'description') } : {}),
        ...(getOptionalStringArg(args, 'version') ? { version: getOptionalStringArg(args, 'version') } : {}),
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
        ...(getOptionalStringArg(args, 'author') ? { author: getOptionalStringArg(args, 'author') } : {}),
      });
      host.skills.register(updated);
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, skillName, app, manifest: updated.manifest });
    },
  };

  const skillMigrateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_skill_migrate',
      'Migrate an MCP App v13/v14 to v15 (v15): validates the old HTML (full document, no <base href>/<form action> outside), adds the v15 bridge client snippet when missing, infers capabilities from the old HTML, and generates a v15 manifest + the list of changes for user review. Returns the new HTML + manifest + files. Local only.',
      {
        html: { type: 'string', description: 'HTML of the old v13/v14 app.' },
        resourceUri: { type: 'string', description: 'ui:// resource URI of the app (kept unchanged).' },
        serverName: { type: 'string', description: 'Server owning the app.' },
        fromVersion: { type: 'string', enum: ['13', '14'], description: 'Source version of the app (default 14).' },
        version: { type: 'string', description: 'v15 version to assign (default 1.0.0).' },
        toolName: { type: 'string', description: 'Tool that produced the app.' },
      },
      ['html', 'resourceUri', 'serverName'],
    ),
    needsApproval: false,
    async execute(args) {
      const result = migrateAppToV15({
        html: getStringArg(args, 'html'),
        resourceUri: getStringArg(args, 'resourceUri'),
        serverName: getStringArg(args, 'serverName'),
        ...(getOptionalStringArg(args, 'fromVersion')
          ? { fromVersion: getOptionalStringArg(args, 'fromVersion') as '13' | '14' }
          : {}),
        ...(getOptionalStringArg(args, 'version') ? { version: getOptionalStringArg(args, 'version') } : {}),
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
      });
      return formatResult({ ok: true, version: MCP_APPS_V15_VERSION, ...result });
    },
  };

  const auditTool: Tool = {
    definition: toolDef(
      'mcp_apps_v15_audit',
      'List the MCP Apps v15 audit trail (v15): host audit log entries (open/close/tools-call, hash-chained) + consent audit entries, with hash-chain verification. Local only.',
      {
        limit: { type: 'number', description: 'Max entries to return (default 50).' },
        server: { type: 'string', description: 'Filter host audit entries by server.' },
        method: { type: 'string', description: 'Filter host audit entries by method (e.g. tools/call, ui/open).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.floor(args['limit']) : 50;
      const entries = host.auditLog.query({
        ...(getOptionalStringArg(args, 'server') ? { server: getOptionalStringArg(args, 'server') } : {}),
        ...(getOptionalStringArg(args, 'method') ? { method: getOptionalStringArg(args, 'method') } : {}),
        limit,
      });
      const consentAudit = host.consent.auditLog().slice(-limit);
      const chain = host.auditLog.verifyChain();
      const consentChain = host.consent.verifyAuditChain();
      return formatResult({
        ok: true,
        version: MCP_APPS_V15_VERSION,
        entries,
        consentAudit,
        chainValid: chain.ok,
        consentChainValid: consentChain.ok,
        stats: host.stats(),
      });
    },
  };

  return [
    registerTool,
    manifestTool,
    declareTool,
    openTool,
    bridgeMessageTool,
    consentTool,
    visualiseTool,
    skillCreateTool,
    skillAddTool,
    skillMigrateTool,
    auditTool,
  ];
}

export const MCP_APPS_V15_TOOLS: Tool[] = createMcpAppsV15Tools();

/** Scaffold app trực tiếp (tiện cho caller dùng tool mà không qua skill). */
export { scaffoldApp };
