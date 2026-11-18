/**
 * MCP Apps host v14 — tool definitions cho agent (v1.34, Team T3).
 *
 * Đưa host v14 ra cho agent dùng như tool thường (không cần chạm code):
 *
 *   - `mcp_apps_v14_register` — đăng ký resource app vào registry
 *     `ui://` (HTML document đầy đủ đã validate + MIME
 *     `text/html;profile=mcp-app`).
 *   - `mcp_apps_v14_declare_tool_ui` — khai báo `_meta.ui` cho một
 *     tool + text fallback BẮT BUỘC (thiếu fallback hoặc resource
 *     chưa đăng ký thì bị từ chối).
 *   - `mcp_apps_v14_list_ui_tools` — liệt kê tool nào có UI, kèm
 *     trạng thái resource + fallback.
 *   - `mcp_apps_v14_negotiate` — capability negotiation: client có
 *     render được app không → UI hay text fallback.
 *   - `mcp_apps_v14_open` — mở app đã đăng ký cho một client (trả
 *     UI sandbox hoặc text fallback theo negotiation).
 *   - `mcp_apps_v14_preview` — xem trước app (frame sandbox + audit
 *     + consent đang chờ của app đó).
 *   - `mcp_apps_v14_consent` — liệt kê consent đang chờ / duyệt /
 *     từ chối action từ UI.
 *   - `mcp_apps_v14_audit` — liệt kê audit log các action từ UI.
 *
 * Toàn bộ chạy local, không gọi mạng ngoài, không cần key. Mở app
 * và duyệt/từ chối consent là thay đổi nhìn thấy được / có hệ quả
 * nên cần approval; đọc registry, negotiation, preview, audit thì
 * không. Module này chỉ export mảng tool — coordinator nối vào
 * ALL_TOOLS sau (không sửa registry trung tâm ở đây).
 */

import type { Tool } from '@open-bot/core';
import {
  McpAppHostV14,
  MCP_APPS_V14_VERSION,
  parseV14ClientCapability,
  type V14ClientAppsCapability,
} from '@open-bot/core/dist/mcp/appsHostV14';
import { validateSandboxAllowList, type V14SandboxAllowList } from '@open-bot/core/dist/mcp/appsPreviewV14';

export const MCP_APPS_V14_TOOL_NAMES = [
  'mcp_apps_v14_register',
  'mcp_apps_v14_declare_tool_ui',
  'mcp_apps_v14_list_ui_tools',
  'mcp_apps_v14_negotiate',
  'mcp_apps_v14_open',
  'mcp_apps_v14_preview',
  'mcp_apps_v14_consent',
  'mcp_apps_v14_audit',
] as const;
export type McpAppsV14ToolName = (typeof MCP_APPS_V14_TOOL_NAMES)[number];

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

/** Parse allow-list CSP từ argument tool (object các mảng hostname). */
function parseAllowListArg(args: Record<string, unknown>): V14SandboxAllowList {
  const raw = getObjectArg(args, 'allowList');
  const out: V14SandboxAllowList = {};
  for (const field of ['scriptHosts', 'styleHosts', 'imageHosts', 'mediaHosts', 'fontHosts', 'connectHosts'] as const) {
    const hosts = raw[field];
    if (hosts === undefined) continue;
    if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== 'string')) {
      throw new Error(`allowList.${field} must be an array of hostnames.`);
    }
    out[field] = hosts as string[];
  }
  return validateSandboxAllowList(out);
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
 * Tạo 8 tool v14 trên một host instance. Không truyền host thì dùng
 * host mặc định của module (một instance cho toàn bộ process — app
 * mở bằng tool này thì tool khác thấy được, khớp hành vi của
 * `MCP_APPS_V113_TOOLS`).
 */
export function createMcpAppsV14Tools(host: McpAppHostV14 = new McpAppHostV14()): Tool[] {
  const registerTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_register',
      'Register an MCP App resource in the ui:// registry (v14): validate the HTML document (full <!doctype html> document only, no embedded external sites, no sandbox-escape patterns), store it under its ui:// URI (MIME text/html or text/html;profile=mcp-app) so a tool can declare it later. Local only, no network.',
      {
        uri: { type: 'string', description: 'App resource URI, e.g. ui://my-server/dashboard.' },
        html: { type: 'string', description: 'Full HTML document of the app (must start with <!doctype html>).' },
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
      const entry = host.registerResource({
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
        version: MCP_APPS_V14_VERSION,
        uri: entry.uri,
        serverName: entry.serverName,
        title: entry.title,
        mimeType: entry.mimeType,
        versionEntry: entry.version,
        sizeBytes: entry.sizeBytes,
      });
    },
  };

  const declareTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_declare_tool_ui',
      'Declare the UI of a tool via _meta.ui (v14): the tool points at an already-registered ui:// resource and MUST provide a full text fallback for clients that cannot render apps (terminal). Rejected when the resource is not registered yet or the fallback is missing/too short.',
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
      const reg = host.declareToolUi(toolName, uiMeta, {
        textFallback,
        ...(getOptionalStringArg(args, 'serverName') ? { serverName: getOptionalStringArg(args, 'serverName') } : {}),
      });
      return formatResult({
        ok: true,
        version: MCP_APPS_V14_VERSION,
        toolName: reg.toolName,
        serverName: reg.serverName,
        resourceUri: reg.declaration.resourceUri,
        displayMode: reg.declaration.displayMode,
        fallbackChars: reg.textFallback.charCount,
        versionEntry: reg.version,
      });
    },
  };

  const listUiToolsTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_list_ui_tools',
      'List tools that declare a UI via _meta.ui (v14), with each tool\'s resource registration status and text-fallback status. Optionally filter by server. Also reports registry stats.',
      {
        serverName: { type: 'string', description: 'Only tools from this MCP server.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const tools = host.listUiTools({
        ...(getOptionalStringArg(args, 'serverName') ? { serverName: getOptionalStringArg(args, 'serverName') } : {}),
      });
      return formatResult({
        ok: true,
        version: MCP_APPS_V14_VERSION,
        tools,
        stats: host.stats(),
      });
    },
  };

  const negotiateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_negotiate',
      'Negotiate MCP Apps capability for a client (v14): given what the client supports, decide whether a tool\'s UI should be sent or the text fallback should be used instead (progressive enhancement).',
      {
        toolName: { type: 'string', description: 'Name of the tool with a UI.' },
        clientSupportsApps: { type: 'boolean', description: 'Whether the client can render MCP Apps in a sandboxed iframe.' },
        renderModes: { type: 'array', items: { type: 'string' }, description: 'Render modes the client supports (inline/fullscreen/pip).' },
        maxWidthPx: { type: 'number', description: 'Max width (px) the client accepts (0 = unlimited).' },
        maxHeightPx: { type: 'number', description: 'Max height (px) the client accepts (0 = unlimited).' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    async execute(args) {
      const toolName = getStringArg(args, 'toolName');
      const client = parseClientArg(args);
      const negotiation = host.negotiateForTool(toolName, client);
      return formatResult({ ok: true, version: MCP_APPS_V14_VERSION, toolName, ...negotiation });
    },
  };

  const openTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_open',
      'Open a registered MCP App for a client (v14): when the client supports Apps, returns the sandboxed iframe frame config (strict CSP + allow-list) and a bridge session id; otherwise returns the full text fallback (progressive enhancement). Opening a visible UI needs approval.',
      {
        uri: { type: 'string', description: 'ui:// URI of the registered app.' },
        toolName: { type: 'string', description: 'Name of the tool owning the app (defaults to the tool recorded at registration).' },
        clientSupportsApps: { type: 'boolean', description: 'Whether the client can render MCP Apps.' },
        renderModes: { type: 'array', items: { type: 'string' }, description: 'Render modes the client supports.' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Display mode to open with.' },
        allowList: { type: 'object', description: 'CSP allow-list: { scriptHosts, styleHosts, imageHosts, mediaHosts, fontHosts, connectHosts } (arrays of hostnames).' },
        allowOpenLink: { type: 'boolean', description: 'Whether the app may open external links (default false).' },
        title: { type: 'string', description: 'Title override.' },
      },
      ['uri'],
    ),
    needsApproval: true,
    async execute(args) {
      const uri = getStringArg(args, 'uri');
      const client = parseClientArg(args);
      const allowList = parseAllowListArg(args);
      const result = host.openRegisteredAppForClient(uri, client, {
        ...(getOptionalStringArg(args, 'toolName') ? { toolName: getOptionalStringArg(args, 'toolName') } : {}),
        ...(getOptionalStringArg(args, 'displayMode')
          ? { displayMode: getOptionalStringArg(args, 'displayMode') as 'inline' | 'fullscreen' | 'pip' }
          : {}),
        allowList,
        allowOpenLink: args['allowOpenLink'] === true,
        ...(getOptionalStringArg(args, 'title') ? { title: getOptionalStringArg(args, 'title') } : {}),
      });
      if (result.mode === 'text') {
        return formatResult({
          ok: true,
          version: MCP_APPS_V14_VERSION,
          mode: 'text',
          textFallback: result.textFallback,
          reason: result.negotiation.reason,
          reasonCode: result.negotiation.reasonCode,
        });
      }
      return formatResult({
        ok: true,
        version: MCP_APPS_V14_VERSION,
        mode: 'ui',
        appId: result.opened.appId,
        bridgeSessionId: result.bridgeSessionId,
        uri: result.opened.uri,
        title: result.opened.title,
        displayMode: result.opened.displayMode,
        sandbox: result.frameConfigV14.sandbox,
        csp: result.frameConfigV14.csp,
        srcdocChars: result.frameConfigV14.srcdoc.length,
        expectedOrigin: result.frameConfigV14.expectedOrigin,
        reason: result.negotiation.reason,
      });
    },
  };

  const previewTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_preview',
      'Preview a registered MCP App (v14): build the sandboxed iframe frame config (strict CSP + allow-list) and show the app\'s UI-action audit log and pending consents, without mounting the app. Use before opening an untrusted app.',
      {
        uri: { type: 'string', description: 'ui:// URI of the registered app.' },
        allowList: { type: 'object', description: 'CSP allow-list: { scriptHosts, styleHosts, imageHosts, mediaHosts, fontHosts, connectHosts }.' },
      },
      ['uri'],
    ),
    needsApproval: false,
    async execute(args) {
      const uri = getStringArg(args, 'uri');
      const allowList = parseAllowListArg(args);
      const preview = host.previewApp(uri, allowList);
      return formatResult({
        ok: true,
        version: MCP_APPS_V14_VERSION,
        uri: preview.uri,
        serverName: preview.serverName,
        title: preview.title,
        mimeType: preview.mimeType,
        versionEntry: preview.version,
        sizeBytes: preview.sizeBytes,
        declaredByTool: preview.declaredByTool,
        hasTextFallback: preview.hasTextFallback,
        sandbox: preview.frameConfig.sandbox,
        csp: preview.frameConfig.csp,
        srcdocChars: preview.frameConfig.srcdoc.length,
        auditActionCount: preview.auditActionCount,
        pendingConsents: preview.pendingConsents,
        audit: preview.audit,
        consents: preview.consents,
      });
    },
  };

  const consentTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_consent',
      'Manage consent for actions requested from a UI (v14): list pending consent requests, or approve/deny one. Approving lets the app call a tool on the user\'s behalf, so deciding needs approval.',
      {
        action: { type: 'string', enum: ['list', 'approve', 'deny'], description: 'What to do: list pending consents, approve one, or deny one.' },
        consentId: { type: 'string', description: 'Consent id (required for approve/deny).' },
        appUri: { type: 'string', description: 'Only consents for this app URI (list only).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      const action = getStringArg(args, 'action');
      if (action === 'list') {
        const consents = host.listPendingConsents(getOptionalStringArg(args, 'appUri'));
        return formatResult({ ok: true, version: MCP_APPS_V14_VERSION, consents });
      }
      if (action !== 'approve' && action !== 'deny') {
        throw new Error('Tool argument "action" must be list, approve or deny.');
      }
      const consentId = getStringArg(args, 'consentId');
      const decided = host.decideConsent(consentId, action === 'approve');
      return formatResult({
        ok: decided,
        version: MCP_APPS_V14_VERSION,
        consentId,
        approved: action === 'approve' && decided,
        ...(decided ? {} : { error: 'Consent no longer pending (already decided or expired).' }),
      });
    },
  };

  const auditTool: Tool = {
    definition: toolDef(
      'mcp_apps_v14_audit',
      'List the audit log of actions requested from MCP App UIs (v14): tool calls, resource reads, link opens, consent decisions — including denied and dropped actions. Newest first.',
      {
        appUri: { type: 'string', description: 'Only actions from this app URI.' },
        sessionId: { type: 'string', description: 'Only actions from this bridge session.' },
        outcome: { type: 'string', enum: ['ok', 'denied', 'error', 'consent-required', 'dropped'], description: 'Only actions with this outcome.' },
        limit: { type: 'number', description: 'Max entries (default 100, max 500).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const entries = host.listUiAudit({
        ...(getOptionalStringArg(args, 'appUri') ? { appUri: getOptionalStringArg(args, 'appUri') } : {}),
        ...(getOptionalStringArg(args, 'sessionId') ? { sessionId: getOptionalStringArg(args, 'sessionId') } : {}),
        ...(getOptionalStringArg(args, 'outcome')
          ? { outcome: getOptionalStringArg(args, 'outcome') as 'ok' | 'denied' | 'error' | 'consent-required' | 'dropped' }
          : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });
      return formatResult({ ok: true, version: MCP_APPS_V14_VERSION, entries });
    },
  };

  return [
    registerTool,
    declareTool,
    listUiToolsTool,
    negotiateTool,
    openTool,
    previewTool,
    consentTool,
    auditTool,
  ];
}

export const MCP_APPS_V14_TOOLS: Tool[] = createMcpAppsV14Tools();
