/**
 * MCP Apps v16 + MCP 2026-07-28 — tool definitions cho agent (v1.36, Đội T3).
 *
 * Đưa lớp v16 ra cho agent dùng như tool thường:
 *
 *   - `mcp_apps_v16_discover` — dựng document `server/discover`
 *     phía server (protocol version + capabilities + extensions +
 *     endpoints + health) hoặc parse + kiểm tra tương thích một
 *     document có sẵn.
 *   - `mcp_apps_v16_stateless_call` — gọi một method qua client
 *     stateless v16 (pool round-robin, không initialize, không
 *     header Mcp-Session-Id, retry transient giữ idempotency key).
 *   - `mcp_apps_v16_mrtr_run` — chạy một method theo MRTR SEP-2322:
 *     server trả input_required thì thu đáp án (đưa qua argument
 *     `answers`) rồi gọi lại method cũ kèm inputResponses +
 *     requestState.
 *   - `mcp_apps_v16_elicit_url_create` — tạo phiên elicitation URL
 *     (OAuth sign-in / payment / credential-refresh / consent).
 *   - `mcp_apps_v16_elicit_url_complete` — hoàn thành phiên bằng
 *     callback token (single-use, ký HMAC).
 *   - `mcp_apps_v16_elicit_form_check` — kiểm tra form mode có được
 *     phép cho danh sách trường không (secret → bắt buộc URL mode).
 *   - `mcp_apps_v16_extensions_negotiate` — thương lượng extensions
 *     (Apps / Tasks, mặc định tắt) giữa client và server.
 *   - `mcp_apps_v16_deprecation_report` — report lộ trình deprecate
 *     Roots/Sampling/Logging (còn bao nhiêu ngày tới 2027-07-28,
 *     migration path, số lần gọi còn lại).
 *   - `mcp_apps_v16_oauth_client_register` — đăng ký Client ID
 *     Metadata Document (validate + phát hiện reuse credential so
 *     với DCR cũ).
 *   - `mcp_apps_v16_apps_declare` — khai báo UI template trước.
 *   - `mcp_apps_v16_apps_prefetch` — prefetch HTML template + hash.
 *   - `mcp_apps_v16_apps_review` — security review template.
 *   - `mcp_apps_v16_apps_open` — mở app (cần extension Apps đã
 *     negotiate + template ready + HTML khớp hash prefetch).
 *   - `mcp_apps_v16_apps_list` — liệt kê template theo trạng thái
 *     pipeline + session đang mở + thống kê host.
 *   - `mcp_apps_v16_migrate_check` — kiểm tra readiness migrate
 *     client/server cũ lên MCP 2026-07-28 + cấu hình stateless
 *     đã chuyển đổi.
 *
 * Toàn bộ chạy local, không gọi mạng ngoài trừ khi coordinator chích
 * transport thật vào (mặc định: stateless_call/mrtr dùng transport
 * do options cung cấp; không có transport thì báo lỗi rõ ràng).
 * Mở app / mở URL elicitation / gọi server là thay đổi nhìn thấy
 * được nên cần approval; đọc / kiểm tra / đăng ký local thì không.
 * Module này chỉ export mảng tool — coordinator nối vào ALL_TOOLS sau.
 */

import type { Tool } from '@open-bot/core';
import {
  AppsHostV16,
  buildSandboxPolicyV16,
  negotiateDisplayModeV16,
} from '@open-bot/core/dist/mcp/appsV16';
import {
  DeprecationPolicyEngineV16,
} from '@open-bot/core/dist/mcp/deprecationPolicyV16';
import {
  UrlElicitationManagerV16,
  checkFormModeAllowed,
  suggestUrlPurpose,
  type UrlElicitationPurpose,
} from '@open-bot/core/dist/mcp/elicitationUrlV16';
import {
  EXTENSION_APPS_ID,
  EXTENSION_TASKS_ID,
  describeNegotiation,
  isExtensionEnabled,
  negotiateExtensions,
} from '@open-bot/core/dist/mcp/extensionsV16';
import {
  MrtrV16Session,
} from '@open-bot/core/dist/mcp/mrtrV16';
import {
  ClientMetadataRegistryV16,
  parseClientMetadataDocument,
} from '@open-bot/core/dist/mcp/oauthClientIdV16';
import {
  DiscoverCacheV16,
  buildServerDiscoverDocumentV16,
  checkVersionCompatibility,
} from '@open-bot/core/dist/mcp/serverDiscoverV16';
import {
  buildReadinessReport,
  migrateStatelessConfig,
  migrationChecklistFor,
} from '@open-bot/core/dist/mcp/mcpV16Migration';
import {
  StatelessClientV16,
  buildV16RequestEnvelope,
  type V16StatelessTransport,
} from '@open-bot/core/dist/mcp/statelessClientV16';

export const MCP_APPS_V16_VERSION = '2026-07-28';

export const MCP_APPS_V16_TOOL_NAMES = [
  'mcp_apps_v16_discover',
  'mcp_apps_v16_stateless_call',
  'mcp_apps_v16_mrtr_run',
  'mcp_apps_v16_elicit_url_create',
  'mcp_apps_v16_elicit_url_complete',
  'mcp_apps_v16_elicit_form_check',
  'mcp_apps_v16_extensions_negotiate',
  'mcp_apps_v16_deprecation_report',
  'mcp_apps_v16_oauth_client_register',
  'mcp_apps_v16_apps_declare',
  'mcp_apps_v16_apps_prefetch',
  'mcp_apps_v16_apps_review',
  'mcp_apps_v16_apps_open',
  'mcp_apps_v16_apps_list',
  'mcp_apps_v16_migrate_check',
] as const;
export type McpAppsV16ToolName = (typeof MCP_APPS_V16_TOOL_NAMES)[number];

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

/** Tuỳ chọn khi tạo tool v16 (coordinator chích transport/state thật). */
export interface McpAppsV16ToolOptions {
  /** Transport cho stateless_call / mrtr_run (mặc định: không có → báo lỗi rõ). */
  transport?: V16StatelessTransport;
  /** Endpoint mặc định cho stateless_call (khi args không đưa endpointUrl). */
  defaultEndpoints?: string[];
  /** Host được phép cho elicitation URL (mặc định: accounts.google.com, github.com). */
  allowedHosts?: string[];
  /** Secret ký requestState MRTR / callback token (mặc định sinh ngẫu nhiên). */
  hmacSecret?: string;
  /** Server scripted cho mrtr_run khi test/demo (method, params) => result. */
  scriptedServer?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

/** State dùng chung của bộ tool v16 (một instance cho toàn process). */
export interface McpAppsV16State {
  appsHost: AppsHostV16;
  elicitation: UrlElicitationManagerV16;
  deprecation: DeprecationPolicyEngineV16;
  metadataRegistry: ClientMetadataRegistryV16;
  discoverCache: DiscoverCacheV16;
}

export function createMcpAppsV16State(options: McpAppsV16ToolOptions = {}): McpAppsV16State {
  return {
    appsHost: new AppsHostV16(),
    elicitation: new UrlElicitationManagerV16({
      allowedHosts: options.allowedHosts ?? ['accounts.google.com', 'github.com'],
      ...(options.hmacSecret ? { callbackSecret: options.hmacSecret } : {}),
    }),
    deprecation: new DeprecationPolicyEngineV16(),
    metadataRegistry: new ClientMetadataRegistryV16(),
    discoverCache: new DiscoverCacheV16(),
  };
}

function requireTransport(
  options: McpAppsV16ToolOptions,
): V16StatelessTransport {
  if (!options.transport) {
    throw new Error(
      'mcp_apps_v16: chưa cấu hình transport — coordinator phải chích V16StatelessTransport vào createMcpAppsV16Tools (tool không tự gọi mạng).',
    );
  }
  return options.transport;
}

/**
 * Tạo 15 tool v16 trên state dùng chung. Không truyền state thì
 * dùng state mặc định của module (một instance cho toàn process).
 */
export function createMcpAppsV16Tools(
  state: McpAppsV16State = createMcpAppsV16State(),
  options: McpAppsV16ToolOptions = {},
): Tool[] {
  const discoverTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_discover',
      'Build (server side) or parse + compatibility-check a server/discover document (MCP 2026-07-28): protocol version, capabilities, extensions, endpoints + health. No initialize handshake. Local only, no network.',
      {
        mode: { type: 'string', enum: ['build', 'parse'], description: 'build: build a document from server info; parse: parse + check an existing document.' },
        serverName: { type: 'string', description: 'Server name (build mode).' },
        serverVersion: { type: 'string', description: 'Server version (build mode).' },
        capabilities: { type: 'object', description: 'Capabilities object, e.g. {tools:{}, apps:{}} (build mode).' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Extension ids the server supports, e.g. io.modelcontextprotocol/ui (build mode).' },
        document: { type: 'object', description: 'Existing discover document to parse (parse mode).' },
        clientSupportedVersions: { type: 'array', items: { type: 'string' }, description: 'Protocol versions the client supports (parse mode).' },
      },
      ['mode'],
    ),
    needsApproval: false,
    async execute(args) {
      const mode = getStringArg(args, 'mode');
      if (mode === 'build') {
        const document = buildServerDiscoverDocumentV16({
          serverName: getStringArg(args, 'serverName'),
          serverVersion: getStringArg(args, 'serverVersion'),
          capabilities: getObjectArg(args, 'capabilities'),
          extensions: (getStringArrayArg(args, 'extensions') ?? []).map((id) => ({ id })),
        });
        return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, document });
      }
      const document = getObjectArg(args, 'document');
      const parsed = buildServerDiscoverDocumentV16({
        serverName: String((document['serverInfo'] as Record<string, unknown>)?.['name'] ?? ''),
        serverVersion: String((document['serverInfo'] as Record<string, unknown>)?.['version'] ?? ''),
        protocolVersion: typeof document['protocolVersion'] === 'string' ? (document['protocolVersion'] as string) : undefined,
        supportedVersions: getStringArrayArg({ v: document['supportedVersions'] }, 'v'),
        capabilities: getObjectArg({ c: document['capabilities'] }, 'c'),
        extensions: (Array.isArray(document['extensions']) ? (document['extensions'] as unknown[]) : [])
          .filter((e): e is string => typeof e === 'string')
          .map((id) => ({ id })),
      });
      const compatibility = checkVersionCompatibility(
        getStringArrayArg(args, 'clientSupportedVersions') ?? ['2026-07-28'],
        parsed.supportedVersions ?? [parsed.protocolVersion],
      );
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, document: parsed, compatibility });
    },
  };

  const statelessCallTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_stateless_call',
      'Call one method through the stateless client v16 (MCP 2026-07-28): no initialize handshake, no Mcp-Session-Id header, every request carries protocol version + capabilities in _meta, round-robin pool with retry on transient errors (same idempotency key). Needs approval because it calls a server.',
      {
        method: { type: 'string', description: 'Method to call, e.g. tools/call (never initialize).' },
        params: { type: 'object', description: 'Method params (without _meta — the client adds it).' },
        endpointUrl: { type: 'string', description: 'Endpoint URL (default: first configured endpoint).' },
      },
      ['method'],
    ),
    needsApproval: true,
    async execute(args) {
      const transport = requireTransport(options);
      const endpoints = options.defaultEndpoints ?? [];
      const endpointUrl = getOptionalStringArg(args, 'endpointUrl') ?? endpoints[0];
      if (!endpointUrl) {
        throw new Error('mcp_apps_v16_stateless_call: thiếu endpointUrl và không có defaultEndpoints.');
      }
      const client = new StatelessClientV16(
        [{ url: endpointUrl }],
        transport,
        { protocolVersion: MCP_APPS_V16_VERSION },
      );
      const result = await client.call(getStringArg(args, 'method'), getObjectArg(args, 'params'));
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, ...result });
    },
  };

  const mrtrRunTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_mrtr_run',
      'Run one method with MRTR (SEP-2322): when the server answers input_required, collect the answers given in `answers` (keyed by input id) and re-call the same method with inputResponses + requestState. The handler is idempotent before the input point and never keeps secrets in requestState. Needs approval because it calls a server.',
      {
        method: { type: 'string', description: 'Method to run, e.g. tools/call.' },
        params: { type: 'object', description: 'Initial params for the first call.' },
        answers: { type: 'object', description: 'Answers keyed by input-request id, e.g. {"project-name": "open-bot"}. Values may be any JSON value.' },
        maxRounds: { type: 'number', description: 'Maximum MRTR rounds (default 8).' },
        dryRunEnvelope: { type: 'boolean', description: 'When true, only build + validate the first request envelope (no server call).' },
      },
      ['method'],
    ),
    needsApproval: true,
    async execute(args) {
      const method = getStringArg(args, 'method');
      if (getBoolArg(args, 'dryRunEnvelope', false)) {
        const envelope = buildV16RequestEnvelope(method, getObjectArg(args, 'params'), {
          protocolVersion: MCP_APPS_V16_VERSION,
        });
        return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, dryRun: true, envelope });
      }
      const answers = getObjectArg(args, 'answers');
      const callFn = async (
        callMethod: string,
        callParams: Record<string, unknown>,
      ): Promise<unknown> => {
        if (options.scriptedServer) return options.scriptedServer(callMethod, callParams);
        const transport = requireTransport(options);
        const endpoints = options.defaultEndpoints ?? [];
        const endpointUrl = endpoints[0];
        if (!endpointUrl) {
          throw new Error('mcp_apps_v16_mrtr_run: thiếu transport endpoint (defaultEndpoints) và không có scriptedServer.');
        }
        const client = new StatelessClientV16([{ url: endpointUrl }], transport, {
          protocolVersion: MCP_APPS_V16_VERSION,
        });
        const out = await client.call(callMethod, callParams);
        return out.result;
      };
      const collector = async (requests: { id: string }[]): Promise<{ id: string; value: unknown }[]> => {
        return requests.map((request) => {
          if (!(request.id in answers)) {
            throw new Error(`MRTR v16: thiếu đáp án cho input "${request.id}" (đưa qua argument answers).`);
          }
          return { id: request.id, value: answers[request.id] };
        });
      };
      const session = new MrtrV16Session(callFn, collector as never, {
        maxRounds: typeof args['maxRounds'] === 'number' ? Math.floor(args['maxRounds'] as number) : undefined,
        ...(options.hmacSecret ? { hmacSecret: options.hmacSecret } : {}),
      });
      const outcome = await session.run(method, getObjectArg(args, 'params'));
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, outcome });
    },
  };

  const elicitUrlCreateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_elicit_url_create',
      'Create a URL-mode elicitation session (MCP 2026-07-28): the ONLY channel for secrets/credentials — OAuth sign-in, payment page, credential refresh. The URL must be https and its host on the allowlist. Returns a session id + callback token. Needs approval because it opens an external page.',
      {
        purpose: { type: 'string', enum: ['oauth-signin', 'payment', 'credential-refresh', 'consent'], description: 'Purpose of the elicitation.' },
        url: { type: 'string', description: 'Target https URL (host must be on the allowlist).' },
        serverName: { type: 'string', description: 'Server requesting the elicitation.' },
        prompt: { type: 'string', description: 'Message shown to the user.' },
      },
      ['url', 'serverName', 'prompt'],
    ),
    needsApproval: true,
    async execute(args) {
      const purpose = (getOptionalStringArg(args, 'purpose') ?? 'oauth-signin') as UrlElicitationPurpose;
      const session = state.elicitation.createSession({
        purpose,
        url: getStringArg(args, 'url'),
        serverName: getStringArg(args, 'serverName'),
        prompt: getStringArg(args, 'prompt'),
      });
      const callbackToken = state.elicitation.issueCallbackToken(session.id);
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        session,
        callbackToken,
        note: 'Mở URL trên trình duyệt; secret (token/code) KHÔNG đi qua form/context — chỉ callback token này mới hoàn thành được phiên.',
      });
    },
  };

  const elicitUrlCompleteTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_elicit_url_complete',
      'Complete a URL-mode elicitation session with its callback token (single-use, HMAC-signed). The reference is a harmless code (e.g. transaction id) — never put a secret/token here.',
      {
        callbackToken: { type: 'string', description: 'Callback token issued by mcp_apps_v16_elicit_url_create.' },
        reference: { type: 'string', description: 'Optional harmless reference (e.g. transaction id).' },
      },
      ['callbackToken'],
    ),
    needsApproval: false,
    async execute(args) {
      const session = state.elicitation.completeByCallback(
        getStringArg(args, 'callbackToken'),
        getOptionalStringArg(args, 'reference'),
      );
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, session });
    },
  };

  const elicitFormCheckTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_elicit_form_check',
      'Check whether form mode is allowed for a list of fields (MCP 2026-07-28): form mode is FORBIDDEN for password / API key / token / payment fields — those must use URL mode. Returns violations (if any) with a suggested URL purpose per field.',
      {
        fields: { type: 'array', items: { type: 'object' }, description: 'Fields to check: [{name, schema}] where schema is a JSON Schema object (optional).' },
      },
      ['fields'],
    ),
    needsApproval: false,
    async execute(args) {
      const rawFields = args['fields'];
      if (!Array.isArray(rawFields)) {
        throw new Error('Tool argument "fields" must be an array.');
      }
      const fields = rawFields.map((field) => {
        if (field === null || typeof field !== 'object' || Array.isArray(field)) {
          throw new Error('Each field must be an object {name, schema?}.');
        }
        const rec = field as Record<string, unknown>;
        return {
          name: getStringArg(rec, 'name'),
          schema: getObjectArg(rec, 'schema'),
        };
      });
      const result = checkFormModeAllowed(fields);
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        ...result,
        suggestions: result.violations.map((v) => ({
          field: v.field,
          suggestedPurpose: suggestUrlPurpose(v.field),
        })),
      });
    },
  };

  const extensionsNegotiateTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_extensions_negotiate',
      'Negotiate MCP extensions (2026-07-28): Apps (io.modelcontextprotocol/ui) and Tasks (io.modelcontextprotocol/tasks) are OFF by default — an extension only turns on when both client and server declare it with a compatible version. Returns per-extension status + a one-line summary.',
      {
        clientRequested: { type: 'array', items: { type: 'string' }, description: 'Extension ids the client requests.' },
        serverSupported: { type: 'array', items: { type: 'string' }, description: 'Extension ids the server supports.' },
        allowUnknown: { type: 'boolean', description: 'Allow unknown (unregistered) extensions to turn on (default false).' },
      },
      ['clientRequested', 'serverSupported'],
    ),
    needsApproval: false,
    async execute(args) {
      const result = negotiateExtensions(
        (getStringArrayArg(args, 'clientRequested') ?? []).map((id) => ({ id })),
        (getStringArrayArg(args, 'serverSupported') ?? []).map((id) => ({ id })),
        { allowUnknown: getBoolArg(args, 'allowUnknown', false) },
      );
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        ...result,
        summary: describeNegotiation(result),
        appsEnabled: isExtensionEnabled(result, EXTENSION_APPS_ID),
        tasksEnabled: isExtensionEnabled(result, EXTENSION_TASKS_ID),
      });
    },
  };

  const deprecationReportTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_deprecation_report',
      'Report the MCP 2026-07-28 deprecation roadmap (SEP-2577): Roots, Sampling, Logging — earliest removal 2027-07-28, 12-month notice, migration path per capability, days left, and how often each is still used. Optionally record one more use of a deprecated method first.',
      {
        recordMethod: { type: 'string', description: 'Optional deprecated method to record a use of first (e.g. sampling/createMessage).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const recordMethod = getOptionalStringArg(args, 'recordMethod');
      if (recordMethod) state.deprecation.recordUsage(recordMethod);
      const rows = state.deprecation.report();
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        earliestRemoval: '2027-07-28',
        noticeDays: 365,
        summary: state.deprecation.describe(),
        rows,
      });
    },
  };

  const oauthClientRegisterTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_oauth_client_register',
      'Register a Client ID Metadata Document (MCP 2026-07-28, replaces Dynamic Client Registration): validates client_id, redirect_uris (https, loopback http only), auth method and issuer, then detects credential reuse against a prior DCR registration. Local only.',
      {
        document: { type: 'object', description: 'Metadata document: {client_id, redirect_uris[], token_endpoint_auth_method?, jwks_uri?, issuer?, ...}.' },
        priorDcrRedirectUris: { type: 'array', items: { type: 'string' }, description: 'Optional prior DCR redirect_uris for the same client_id (reuse detection).' },
      },
      ['document'],
    ),
    needsApproval: false,
    async execute(args) {
      const document = parseClientMetadataDocument(getObjectArg(args, 'document'));
      const priorUris = getStringArrayArg(args, 'priorDcrRedirectUris');
      if (priorUris) {
        state.metadataRegistry.notePriorDcrRegistration(document.client_id, {
          redirect_uris: priorUris,
        });
      }
      const result = state.metadataRegistry.register(document);
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, ...result });
    },
  };

  const appsDeclareTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_apps_declare',
      'Declare an MCP App UI template in advance (v16 pipeline step 1: declare -> prefetch -> security review -> open). Validates the v15 manifest (kebab-case name, semver, ui:// resource, sandbox/CSP profile). Local only.',
      {
        name: { type: 'string', description: 'App name in kebab-case, e.g. dashboard.' },
        version: { type: 'string', description: 'App version as semver, e.g. 1.2.0.' },
        server: { type: 'string', description: 'Server owning the app.' },
        resourceUri: { type: 'string', description: 'ui:// resource URI of the app.' },
        description: { type: 'string', description: 'Short description (max 500 chars).' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities the app requests.' },
        sandboxProfile: { type: 'string', enum: ['display-only', 'interactive', 'privileged'], description: 'Sandbox profile (default display-only).' },
        cspProfile: { type: 'string', enum: ['strict', 'media', 'network'], description: 'CSP profile (default strict).' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip'], description: 'Suggested display mode.' },
      },
      ['name', 'version', 'server', 'resourceUri'],
    ),
    needsApproval: false,
    async execute(args) {
      const template = state.appsHost.declareTemplate({
        name: getStringArg(args, 'name'),
        version: getStringArg(args, 'version'),
        server: getStringArg(args, 'server'),
        resourceUri: getStringArg(args, 'resourceUri'),
        ...(getOptionalStringArg(args, 'description') ? { description: getOptionalStringArg(args, 'description') } : {}),
        capabilities: getStringArrayArg(args, 'capabilities') ?? [],
        sandboxProfile: getOptionalStringArg(args, 'sandboxProfile') ?? 'display-only',
        cspProfile: getOptionalStringArg(args, 'cspProfile') ?? 'strict',
        ...(getOptionalStringArg(args, 'displayMode') ? { displayMode: getOptionalStringArg(args, 'displayMode') } : {}),
      });
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, template });
    },
  };

  const appsPrefetchTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_apps_prefetch',
      'Prefetch an MCP App template HTML (v16 pipeline step 2): stores the HTML + its sha256 integrity hash. Rejects oversized HTML and HTML that loads scripts from outside URLs. A re-prefetch resets the security review. Local only.',
      {
        name: { type: 'string', description: 'Declared app name.' },
        html: { type: 'string', description: 'Full HTML document of the app.' },
      },
      ['name', 'html'],
    ),
    needsApproval: false,
    async execute(args) {
      const template = state.appsHost.prefetchTemplate(
        getStringArg(args, 'name'),
        getStringArg(args, 'html'),
      );
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, template });
    },
  };

  const appsReviewTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_apps_review',
      'Security-review an MCP App template (v16 pipeline step 3): approve makes it ready to open, reject blocks it until a re-prefetch + new review. For privileged apps the note must mention "privileged" explicitly. Local only.',
      {
        name: { type: 'string', description: 'Declared app name.' },
        decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Review decision.' },
        reviewer: { type: 'string', description: 'Name of the reviewer.' },
        note: { type: 'string', description: 'Review note (required to mention "privileged" for privileged apps).' },
      },
      ['name', 'decision', 'reviewer'],
    ),
    needsApproval: false,
    async execute(args) {
      const template = state.appsHost.reviewTemplate(
        getStringArg(args, 'name'),
        getStringArg(args, 'decision') as 'approved' | 'rejected',
        getStringArg(args, 'reviewer'),
        getOptionalStringArg(args, 'note'),
      );
      return formatResult({ ok: true, version: MCP_APPS_V16_VERSION, template });
    },
  };

  const appsOpenTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_apps_open',
      'Open an MCP App (v16 pipeline step 4): requires the Apps extension (io.modelcontextprotocol/ui) negotiated ON, a reviewed-ready template, and HTML matching the prefetched sha256 hash. Returns the session + sandbox policy. Needs approval because opening an app is user-visible.',
      {
        name: { type: 'string', description: 'Declared app name.' },
        html: { type: 'string', description: 'HTML to render (must match the prefetched hash).' },
        clientExtensions: { type: 'array', items: { type: 'string' }, description: 'Extension ids the client declares.' },
        serverExtensions: { type: 'array', items: { type: 'string' }, description: 'Extension ids the server declares.' },
        displayMode: { type: 'string', enum: ['inline', 'fullscreen', 'pip', 'text-only'], description: 'Requested display mode.' },
      },
      ['name', 'html', 'clientExtensions', 'serverExtensions'],
    ),
    needsApproval: true,
    async execute(args) {
      const negotiation = negotiateExtensions(
        (getStringArrayArg(args, 'clientExtensions') ?? []).map((id) => ({ id })),
        (getStringArrayArg(args, 'serverExtensions') ?? []).map((id) => ({ id })),
      );
      const session = state.appsHost.openApp({
        name: getStringArg(args, 'name'),
        html: getStringArg(args, 'html'),
        negotiation,
        requestedDisplayMode: getOptionalStringArg(args, 'displayMode'),
      });
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        session,
        sandboxPolicy: buildSandboxPolicyV16(
          session.sandboxPolicy.sandboxProfile,
          session.sandboxPolicy.cspProfile,
        ),
        displayModeNegotiated: negotiateDisplayModeV16(
          getOptionalStringArg(args, 'displayMode'),
          session.sandboxPolicy.sandboxProfile,
        ),
      });
    },
  };

  const appsListTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_apps_list',
      'List MCP App v16 templates (by pipeline status) and open sessions, plus host stats (template counts, cached bytes). Read-only, local only.',
      {
        status: { type: 'string', enum: ['declared', 'prefetched', 'review-approved', 'review-rejected', 'ready'], description: 'Only list templates in this pipeline status (omit for all).' },
        includeSessions: { type: 'boolean', description: 'Include open sessions (default true).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const status = getOptionalStringArg(args, 'status') as
        | 'declared'
        | 'prefetched'
        | 'review-approved'
        | 'review-rejected'
        | 'ready'
        | undefined;
      const includeSessions = getBoolArg(args, 'includeSessions', true);
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        stats: state.appsHost.stats(),
        templates: state.appsHost.listTemplates(status),
        sessions: includeSessions ? state.appsHost.listSessions() : [],
      });
    },
  };

  const migrateCheckTool: Tool = {
    definition: toolDef(
      'mcp_apps_v16_migrate_check',
      'Check readiness for migrating a legacy MCP client/server to MCP 2026-07-28 (v16): flags blocking issues (initialize, Mcp-Session-Id, missing server/discover, server-initiated requests, form elicitation for secrets, Dynamic Client Registration), warnings (old protocol version, deprecated Roots/Sampling/Logging), a 0-100 readiness score, and a migrated stateless-client config (endpoints + capabilities, with dropped legacy pieces listed). Local only.',
      {
        role: { type: 'string', enum: ['client', 'server', 'app-host'], description: 'Role to check (default client).' },
        config: { type: 'object', description: 'Legacy config to check: {usesInitialize, usesSessionIdHeader, hasServerDiscover, protocolVersion, deprecatedCapabilities[], usesServerInitiatedRequests, formElicitsSecrets, usesDynamicClientRegistration, declaredExtensions[], declaresAppTemplates, endpointUrls[], name, version}.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      const role = (getOptionalStringArg(args, 'role') ?? 'client') as
        | 'client'
        | 'server'
        | 'app-host';
      const config = getObjectArg(args, 'config');
      const legacyConfig: Record<string, unknown> = { ...config };
      const report = buildReadinessReport(
        {
          usesInitialize: legacyConfig['usesInitialize'] === true,
          usesSessionIdHeader: legacyConfig['usesSessionIdHeader'] === true,
          hasServerDiscover: legacyConfig['hasServerDiscover'] === true,
          protocolVersion:
            typeof legacyConfig['protocolVersion'] === 'string'
              ? (legacyConfig['protocolVersion'] as string)
              : undefined,
          deprecatedCapabilities: getStringArrayArg({ v: legacyConfig['deprecatedCapabilities'] }, 'v'),
          usesServerInitiatedRequests: legacyConfig['usesServerInitiatedRequests'] === true,
          formElicitsSecrets: legacyConfig['formElicitsSecrets'] === true,
          usesDynamicClientRegistration: legacyConfig['usesDynamicClientRegistration'] === true,
          declaredExtensions: getStringArrayArg({ v: legacyConfig['declaredExtensions'] }, 'v'),
          declaresAppTemplates: legacyConfig['declaresAppTemplates'] === true,
          endpointUrls: getStringArrayArg({ v: legacyConfig['endpointUrls'] }, 'v'),
          name: typeof legacyConfig['name'] === 'string' ? (legacyConfig['name'] as string) : undefined,
          version: typeof legacyConfig['version'] === 'string' ? (legacyConfig['version'] as string) : undefined,
        },
        { role },
      );
      return formatResult({
        ok: true,
        version: MCP_APPS_V16_VERSION,
        report,
        migratedConfig: migrateStatelessConfig({
          usesInitialize: legacyConfig['usesInitialize'] === true,
          usesSessionIdHeader: legacyConfig['usesSessionIdHeader'] === true,
          usesServerInitiatedRequests: legacyConfig['usesServerInitiatedRequests'] === true,
          deprecatedCapabilities: getStringArrayArg({ v: legacyConfig['deprecatedCapabilities'] }, 'v'),
          declaredExtensions: getStringArrayArg({ v: legacyConfig['declaredExtensions'] }, 'v'),
          endpointUrls: getStringArrayArg({ v: legacyConfig['endpointUrls'] }, 'v'),
          name: typeof legacyConfig['name'] === 'string' ? (legacyConfig['name'] as string) : undefined,
          version: typeof legacyConfig['version'] === 'string' ? (legacyConfig['version'] as string) : undefined,
        }),
        checklist: migrationChecklistFor(role),
      });
    },
  };

  return [
    discoverTool,
    statelessCallTool,
    mrtrRunTool,
    elicitUrlCreateTool,
    elicitUrlCompleteTool,
    elicitFormCheckTool,
    extensionsNegotiateTool,
    deprecationReportTool,
    oauthClientRegisterTool,
    appsDeclareTool,
    appsPrefetchTool,
    appsReviewTool,
    appsOpenTool,
    appsListTool,
    migrateCheckTool,
  ];
}

export const MCP_APPS_V16_TOOLS: Tool[] = createMcpAppsV16Tools();
