/**
 * Protocols v8 tools for @open-bot/tools (v1.39, Team T2).
 *
 * The agent drives the protocols-v8 stack by tool call:
 *  - protocol_v8_discover     — server/discover + list tools (read; stateless, no initialize)
 *  - protocol_v8_versions     — version matrix / extensions / deprecation calendar / changes since v7 / downgrade to v7 (read)
 *  - protocol_v8_extensions   — negotiate MCP extensions local vs peer (read)
 *  - protocol_v8_stateless    — MCP stateless core: ping / tools list+call / resources / prompts / stateless check (local action)
 *  - protocol_v8_legacy       — legacy stateful session adapter: initialize / call via session / list / close (local action; deprecated)
 *  - protocol_v8_apps         — MCP Apps: register ui:// resource / render / validate HTML / CSP / call-back check (local action)
 *  - protocol_v8_tasks        — Tasks extension: submit / get (poll) / update (MRTR) / cancel / counts / sweep (local action)
 *  - protocol_v8_oauth        — OAuth 2.1 / OIDC: PKCE generate+verify / redirect validate+match / auth request / token exchange / client credentials / OIDC discovery / managed auth (read)
 *  - protocol_v8_deprecation  — deprecation tracker: record / counts / report / migration plan / transport check / removal status (local action)
 *  - protocol_v8_nanda        — NANDA local sketch: identity create / verify / registry announce+discover / trust pin+revoke+check (local action)
 *  - protocol_v8_server_card  — Server Cards: build from a registry entry / validate (read)
 *  - protocol_v8_skills       — Skills over MCP: register / list metadata / body / asset / read skill:// URI / search / unregister (local action)
 *
 * Factory:
 *   createProtocolV116Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V116_TOOLS                       (unbound placeholder)
 *
 * State: when the host does not bind its own stores, the factory
 * creates one shared in-memory set (stateless server with a demo
 * echo tool, legacy adapter over it, app registry + host, task
 * engine with an echo runner and an ask-input runner, deprecation
 * tracker, NANDA registry + trust store, skill registry) and
 * shares it across the 12 tools, so the tools work standalone.
 * The host may override any piece via ProtocolV116ToolOptions.
 *
 * SAFETY: the tools never carry credentials (PKCE verifiers and
 * tokens are validated, never stored; NANDA private keys stay
 * inside the identity object and are never serialised), never
 * write to disk by themselves (registries and the task store are
 * in-memory; the host mirrors them), and never open a network
 * connection (discovery is local; the MCP transport is
 * host-supplied when bound).
 */
import type { Tool } from '@open-bot/core';
import {
  McpV8AppHost,
  McpV8AppResourceRegistry,
  McpV8DeprecationTracker,
  McpV8NandaIdentity,
  McpV8NandaRegistry,
  McpV8NandaTrustStore,
  McpV8SkillPackRegistry,
  McpV8StatelessClient,
  McpV8StatelessServer,
  McpV8LegacySessionAdapter,
  McpV8TaskEngine,
  buildMcpV8AuthorizationUrl,
  buildMcpV8DeprecationReport,
  buildMcpV8ServerCard,
  checkMcpV8Stateless,
  checkMcpV8Transport,
  createLoopbackMcpV8Sender,
  defaultMcpV8ExtensionOffer,
  generateMcpV8PkceVerifier,
  mcpV8AppReferencedDomains,
  mcpV8IsDeprecated,
  mcpV8MigrationPlan,
  mcpV8AllMigrationPlans,
  mcpV8PkceChallengeS256,
  mcpV8SkillBodyUri,
  matchMcpV8RedirectUri,
  negotiateAllProtocolsV8,
  negotiateMcpV8Extensions,
  negotiateProtocolV8Version,
  protocolV8ChangesSinceV7,
  protocolV8DeprecationCalendar,
  protocolV8DowngradeToV7,
  protocolV8MatrixSummary,
  validateMcpV8AppCallback,
  validateMcpV8AppHtml,
  validateMcpV8AuthorizationRequest,
  validateMcpV8ClientCredentials,
  validateMcpV8ManagedAuthorization,
  validateMcpV8OidcDiscovery,
  validateMcpV8RedirectUriShape,
  validateMcpV8ServerCard,
  validateMcpV8SkillPack,
  validateMcpV8TokenInfo,
  validateMcpV8TokenRequest,
  verifyMcpV8NandaDocument,
  verifyMcpV8Pkce,
  MCP_V8_APP_MIME_TYPE,
  MCP_V8_DEPRECATIONS,
  MCP_V8_EXTENSIONS,
  MCP_V8_TASK_METHODS,
  PROTOCOL_V8_CURRENT_VERSIONS,
  PROTOCOL_V8_VERSION_MATRIX,
  type McpV8AppCallback,
  type McpV8AppResource,
  type McpV8AuthorizationRequest,
  type McpV8ClientCredentialsRequest,
  type McpV8DeprecationWarning,
  type McpV8NandaIdentityDocument,
  type McpV8OAuthClient,
  type McpV8OidcDiscovery,
  type McpV8ServerCard,
  type McpV8SkillPack,
  type McpV8StatelessTransport,
  type McpV8TokenInfo,
  type McpV8TokenRequest,
  type ProtocolV8Family,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  return getStringArg(args, name);
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  return value;
}

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

export interface ProtocolV116ToolOptions {
  /** MCP transport accessor (the host binds its server endpoint for discover). */
  getMcpTransport?: () => McpV8StatelessTransport | null;
  /** Stateless server accessor (the host binds its server). */
  getStatelessServer?: () => McpV8StatelessServer | null;
  /** App registry accessor (the host binds its registry). */
  getAppRegistry?: () => McpV8AppResourceRegistry | null;
  /** Task engine accessor (the host binds its engine). */
  getTaskEngine?: () => McpV8TaskEngine | null;
  /** Deprecation tracker accessor (the host binds its tracker). */
  getDeprecationTracker?: () => McpV8DeprecationTracker | null;
  /** NANDA registry accessor (the host binds its registry). */
  getNandaRegistry?: () => McpV8NandaRegistry | null;
  /** NANDA trust store accessor (the host binds its trust store). */
  getNandaTrustStore?: () => McpV8NandaTrustStore | null;
  /** Skill registry accessor (the host binds its registry). */
  getSkillRegistry?: () => McpV8SkillPackRegistry | null;
}

export function createProtocolV116Tools(opts: ProtocolV116ToolOptions = {}): Tool[] {
  let fallbackServer: McpV8StatelessServer | null = null;
  let fallbackLegacy: McpV8LegacySessionAdapter | null = null;
  let fallbackApps: McpV8AppResourceRegistry | null = null;
  let fallbackAppHost: McpV8AppHost | null = null;
  let fallbackTasks: McpV8TaskEngine | null = null;
  let fallbackDeprecation: McpV8DeprecationTracker | null = null;
  let fallbackNanda: McpV8NandaRegistry | null = null;
  let fallbackTrust: McpV8NandaTrustStore | null = null;
  let fallbackSkills: McpV8SkillPackRegistry | null = null;

  const needServer = (): McpV8StatelessServer => {
    const found = opts.getStatelessServer?.() ?? fallbackServer;
    if (found) return found;
    fallbackServer = new McpV8StatelessServer();
    fallbackServer.registerTool(
      { name: 'echo', description: 'Echoes the input text back.', inputSchema: { type: 'object', properties: { text: {} }, required: ['text'] } },
      (args) => ({
        content: [{ type: 'text', text: String(args['text'] ?? '') }],
        isError: false,
        structuredContent: { echo: String(args['text'] ?? '') },
      }),
    );
    return fallbackServer;
  };
  const needLegacy = (): McpV8LegacySessionAdapter => {
    if (fallbackLegacy) return fallbackLegacy;
    fallbackLegacy = new McpV8LegacySessionAdapter(needServer());
    return fallbackLegacy;
  };
  const needApps = (): { registry: McpV8AppResourceRegistry; host: McpV8AppHost } => {
    const registry = opts.getAppRegistry?.() ?? fallbackApps ?? (fallbackApps = new McpV8AppResourceRegistry());
    if (!fallbackAppHost) fallbackAppHost = new McpV8AppHost(registry);
    return { registry, host: fallbackAppHost };
  };
  const needTasks = (): McpV8TaskEngine => {
    const found = opts.getTaskEngine?.() ?? fallbackTasks;
    if (found) return found;
    fallbackTasks = new McpV8TaskEngine();
    fallbackTasks.registerRunner('echo', async (_tool, args) => ({ echo: String(args['text'] ?? '') }));
    fallbackTasks.registerRunner('ask-name', async (_tool, args, _task, control) => {
      const answer = await control.askInput({ question: 'What is your name?', field: 'name' });
      return { greeting: `Hello, ${String(answer['name'] ?? 'stranger')}!`, original: String(args['text'] ?? '') };
    });
    return fallbackTasks;
  };
  const needDeprecation = (): McpV8DeprecationTracker => {
    return opts.getDeprecationTracker?.() ?? fallbackDeprecation ?? (fallbackDeprecation = new McpV8DeprecationTracker());
  };
  const needNanda = (): { registry: McpV8NandaRegistry; trust: McpV8NandaTrustStore } => {
    const registry = opts.getNandaRegistry?.() ?? fallbackNanda ?? (fallbackNanda = new McpV8NandaRegistry());
    const trust = opts.getNandaTrustStore?.() ?? fallbackTrust ?? (fallbackTrust = new McpV8NandaTrustStore());
    return { registry, trust };
  };
  const needSkills = (): McpV8SkillPackRegistry => {
    return opts.getSkillRegistry?.() ?? fallbackSkills ?? (fallbackSkills = new McpV8SkillPackRegistry());
  };

  const discover: Tool = {
    definition: toolDef(
      'protocol_v8_discover',
      'MCP server/discover (read): asks the configured MCP server for its discovery document (protocol version, capabilities, extensions, deprecations, transports) and lists its tools. Stateless 2026-07-28 — no initialize handshake, no session id. Without a host transport it uses the local demo server.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const transport = opts.getMcpTransport?.() ?? null;
        if (transport) {
          const client = new McpV8StatelessClient(transport);
          const discovered = await client.discover();
          const tools = await client.listTools();
          return JSON.stringify({ discovered, tools }, null, 2);
        }
        const server = needServer();
        const client = new McpV8StatelessClient(createLoopbackMcpV8Sender(server));
        const discovered = await client.discover();
        const tools = await client.listTools();
        return JSON.stringify({ discovered, tools, localDemo: true }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const versions: Tool = {
    definition: toolDef(
      'protocol_v8_versions',
      'Protocol v8 version matrix (read): current versions per family, MCP extension registry, deprecation calendar, changes since v7, downgrade to v7, or negotiation for one family / all families.',
      {
        action: { type: 'string', description: 'matrix | extensions | deprecations | changes | downgrade | negotiate | negotiate-all.' },
        family: { type: 'string', description: 'Family for negotiate (a2a, mcp, ucp, acp, gov, agui, a2ui, poppy, nanda).' },
        serverVersions: { type: 'array', description: 'Versions the peer offers (for negotiate).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'matrix':
            return JSON.stringify({ current: PROTOCOL_V8_CURRENT_VERSIONS, matrix: PROTOCOL_V8_VERSION_MATRIX, summary: protocolV8MatrixSummary() }, null, 2);
          case 'extensions':
            return JSON.stringify({ count: MCP_V8_EXTENSIONS.length, extensions: MCP_V8_EXTENSIONS }, null, 2);
          case 'deprecations':
            return JSON.stringify({ count: MCP_V8_DEPRECATIONS.length, deprecations: MCP_V8_DEPRECATIONS, calendar: protocolV8DeprecationCalendar() }, null, 2);
          case 'changes':
            return JSON.stringify({ changes: protocolV8ChangesSinceV7() }, null, 2);
          case 'downgrade':
            return JSON.stringify({ downgradeToV7: protocolV8DowngradeToV7() }, null, 2);
          case 'negotiate': {
            const family = getStringArg(args, 'family') as ProtocolV8Family;
            const serverVersions = getStringArrayArg(args, 'serverVersions');
            return JSON.stringify({ negotiation: negotiateProtocolV8Version(family, serverVersions) }, null, 2);
          }
          case 'negotiate-all': {
            const offered = args['serverVersions'] === undefined
              ? {}
              : (getRecordArg(args, 'serverVersions') as unknown as Partial<Record<ProtocolV8Family, readonly string[]>>);
            return JSON.stringify({ negotiations: negotiateAllProtocolsV8(offered) }, null, 2);
          }
          default:
            throw new Error(`Unknown action "${action}". Use matrix | extensions | deprecations | changes | downgrade | negotiate | negotiate-all.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const extensions: Tool = {
    definition: toolDef(
      'protocol_v8_extensions',
      'Negotiate MCP extensions (read): given the local offer and the peer offer, returns the active extensions (both sides + implemented), local-only, peer-only and unknown ids. Extensions are off by default; unknown ids are never activated.',
      {
        localOffer: { type: 'array', description: 'Extension ids the local side offers (default: all implemented).' },
        peerOffer: { type: 'array', description: 'Extension ids the peer offers.' },
      },
      ['peerOffer'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const localOffer = args['localOffer'] === undefined
          ? defaultMcpV8ExtensionOffer()
          : getStringArrayArg(args, 'localOffer');
        const peerOffer = getStringArrayArg(args, 'peerOffer');
        const negotiation = negotiateMcpV8Extensions(localOffer, peerOffer);
        return JSON.stringify({ negotiation, registry: MCP_V8_EXTENSIONS }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stateless: Tool = {
    definition: toolDef(
      'protocol_v8_stateless',
      'MCP stateless core v8 (local action): ping / tools list+call / resources list+read / prompts list+get / stateless check against the shared in-memory server (demo echo tool). Requests are self-describing; the server holds zero sessions.',
      {
        action: { type: 'string', description: 'ping | tools-list | tools-call | resources-list | resources-read | prompts-list | prompts-get | check.' },
        name: { type: 'string', description: 'Tool / prompt name (tools-call, prompts-get).' },
        arguments: { type: 'object', description: 'Tool / prompt arguments.' },
        uri: { type: 'string', description: 'Resource URI (resources-read).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const server = needServer();
        const client = new McpV8StatelessClient(createLoopbackMcpV8Sender(server));
        switch (action) {
          case 'ping':
            return JSON.stringify({ ping: await client.ping() }, null, 2);
          case 'tools-list':
            return JSON.stringify(await client.listTools(), null, 2);
          case 'tools-call': {
            const name = getStringArg(args, 'name');
            const callArgs = args['arguments'] === undefined ? {} : getRecordArg(args, 'arguments');
            return JSON.stringify({ result: await client.callTool(name, callArgs) }, null, 2);
          }
          case 'resources-list':
            return JSON.stringify(await client.listResources(), null, 2);
          case 'resources-read': {
            const uri = getStringArg(args, 'uri');
            return JSON.stringify(await client.readResource(uri), null, 2);
          }
          case 'prompts-list':
            return JSON.stringify(await client.listPrompts(), null, 2);
          case 'prompts-get': {
            const name = getStringArg(args, 'name');
            const callArgs = args['arguments'] === undefined ? {} : getRecordArg(args, 'arguments');
            return JSON.stringify(await client.getPrompt(name, callArgs), null, 2);
          }
          case 'check': {
            const request = {
              jsonrpc: '2.0' as const,
              id: 'check-1',
              method: 'ping',
              params: { _meta: { protocolVersion: '2026-07-28', clientName: 'check', tenant: 'default' } },
            };
            return JSON.stringify({ check: await checkMcpV8Stateless(server, request) }, null, 2);
          }
          default:
            throw new Error(`Unknown action "${action}". Use ping | tools-list | tools-call | resources-list | resources-read | prompts-list | prompts-get | check.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const legacy: Tool = {
    definition: toolDef(
      'protocol_v8_legacy',
      'Legacy stateful MCP session adapter (local action; DEPRECATED): initialize opens a session (with a deprecation warning), calls run through the session, close ends it. New integrations must use protocol_v8_stateless instead; sessions leave after 2027-07-28.',
      {
        action: { type: 'string', description: 'initialize | call | sessions | close | close-all.' },
        sessionId: { type: 'string', description: 'Session id (call, close).' },
        method: { type: 'string', description: 'Stateless method to run through the session (call): ping, tools/list, tools/call, resources/list, resources/read, prompts/list, prompts/get, server/discover.' },
        params: { type: 'object', description: 'Method params (call).' },
        clientName: { type: 'string', description: 'Client name for initialize.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const adapter = needLegacy();
        switch (action) {
          case 'initialize': {
            const clientName = getOptionalStringArg(args, 'clientName') ?? 'legacy-client';
            const response = await adapter.handleLegacy({
              jsonrpc: '2.0',
              id: `legacy-init-${Date.now()}`,
              method: 'initialize',
              params: { protocolVersion: '2026-07-28', clientInfo: { name: clientName, version: '1.0' } },
            });
            return JSON.stringify({ response, sessions: adapter.sessionCount() }, null, 2);
          }
          case 'call': {
            const sessionId = getStringArg(args, 'sessionId');
            const method = getStringArg(args, 'method');
            const params = args['params'] === undefined ? {} : getRecordArg(args, 'params');
            const response = await adapter.handleLegacy({
              jsonrpc: '2.0',
              id: `legacy-call-${Date.now()}`,
              method,
              params: { ...params, _sessionId: sessionId },
            });
            return JSON.stringify({ response }, null, 2);
          }
          case 'sessions':
            return JSON.stringify({ sessions: adapter.sessionIds(), count: adapter.sessionCount() }, null, 2);
          case 'close': {
            const sessionId = getStringArg(args, 'sessionId');
            return JSON.stringify({ closed: adapter.closeSession(sessionId), remaining: adapter.sessionCount() }, null, 2);
          }
          case 'close-all':
            return JSON.stringify({ closed: adapter.closeAllSessions(), remaining: adapter.sessionCount() }, null, 2);
          default:
            throw new Error(`Unknown action "${action}". Use initialize | call | sessions | close | close-all.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const apps: Tool = {
    definition: toolDef(
      'protocol_v8_apps',
      'MCP Apps host (local action): register a ui:// resource (HTML validated, undeclared domains refused), render it into a sandbox descriptor (sandbox attribute + CSP from declared domains), validate HTML, or check a UI-to-tool call-back.',
      {
        action: { type: 'string', description: 'register | render | validate | callback | list | domains.' },
        resource: { type: 'object', description: 'App resource: {uri (ui://…), name, html, mimeType ("text/html;profile=mcp-app"), domains, allowedTools, description?, toolName?}.' },
        toolName: { type: 'string', description: 'Tool the UI belongs to (render).' },
        resourceUri: { type: 'string', description: 'UI resource URI (render, validate, domains).' },
        callback: { type: 'object', description: 'Call-back: {resourceUri, tool, arguments?} (callback).' },
        html: { type: 'string', description: 'HTML to validate (validate).' },
        domains: { type: 'array', description: 'Declared domains for validate.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { registry, host } = needApps();
        switch (action) {
          case 'register': {
            const resource = getRecordArg(args, 'resource') as unknown as McpV8AppResource;
            const registration = registry.register(resource);
            return JSON.stringify({ registration }, null, 2);
          }
          case 'render': {
            const toolName = getStringArg(args, 'toolName');
            const resourceUri = getStringArg(args, 'resourceUri');
            return JSON.stringify({ render: host.render({ toolName, resourceUri }) }, null, 2);
          }
          case 'validate': {
            const html = getStringArg(args, 'html');
            const domains = args['domains'] === undefined ? [] : getStringArrayArg(args, 'domains');
            return JSON.stringify({ validation: validateMcpV8AppHtml(html, domains) }, null, 2);
          }
          case 'callback': {
            const callback = getRecordArg(args, 'callback') as unknown as McpV8AppCallback;
            return JSON.stringify({ check: host.checkCallback(callback), blocked: host.blockedCallbackCount() }, null, 2);
          }
          case 'list':
            return JSON.stringify({ uris: registry.uris(), count: registry.size() }, null, 2);
          case 'domains': {
            const resourceUri = getStringArg(args, 'resourceUri');
            const resource = registry.get(resourceUri);
            if (resource === undefined) throw new Error(`App resource "${resourceUri}" is not registered.`);
            return JSON.stringify({
              declared: resource.domains,
              referenced: mcpV8AppReferencedDomains(resource.html),
              mimeType: MCP_V8_APP_MIME_TYPE,
            }, null, 2);
          }
          default:
            throw new Error(`Unknown action "${action}". Use register | render | validate | callback | list | domains.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tasks: Tool = {
    definition: toolDef(
      'protocol_v8_tasks',
      'MCP Tasks extension (local action): submit a tool run as a task (returns the handle immediately, never blocks), poll with get, feed input mid-flight with update (MRTR), cancel, counts, sweep overdue. The final result is embedded in the Task object — there is no blocking tasks/result.',
      {
        action: { type: 'string', description: 'submit | get | update | cancel | counts | sweep | methods.' },
        toolName: { type: 'string', description: 'Tool to run (submit): echo (returns at once) or ask-name (asks for input, then greets).' },
        arguments: { type: 'object', description: 'Tool arguments (submit).' },
        taskId: { type: 'string', description: 'Task id (get, update, cancel).' },
        input: { type: 'object', description: 'Input for the waiting task (update).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const engine = needTasks();
        switch (action) {
          case 'submit': {
            const toolName = getStringArg(args, 'toolName');
            const callArgs = args['arguments'] === undefined ? {} : getRecordArg(args, 'arguments');
            return JSON.stringify({ task: engine.submit(toolName, callArgs) }, null, 2);
          }
          case 'get': {
            const taskId = getStringArg(args, 'taskId');
            return JSON.stringify({ task: engine.get(taskId) }, null, 2);
          }
          case 'update': {
            const taskId = getStringArg(args, 'taskId');
            const input = getRecordArg(args, 'input');
            return JSON.stringify({ task: engine.update(taskId, input) }, null, 2);
          }
          case 'cancel': {
            const taskId = getStringArg(args, 'taskId');
            return JSON.stringify({ task: engine.cancel(taskId) }, null, 2);
          }
          case 'counts':
            return JSON.stringify({ counts: engine.counts() }, null, 2);
          case 'sweep':
            return JSON.stringify({ swept: engine.sweepOverdue() }, null, 2);
          case 'methods':
            return JSON.stringify({ methods: MCP_V8_TASK_METHODS, note: 'No tasks/result (blocking) and no tasks/list — removed by SEP-2663.' }, null, 2);
          default:
            throw new Error(`Unknown action "${action}". Use submit | get | update | cancel | counts | sweep | methods.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const oauth: Tool = {
    definition: toolDef(
      'protocol_v8_oauth',
      'OAuth 2.1 / OIDC alignment (read): PKCE generate + verify (S256 mandatory, plain refused), redirect URI validate + exact-match, authorization request validate + URL, token exchange validate, Client Credentials validate, OIDC discovery validate, Enterprise Managed Authorization validate.',
      {
        action: { type: 'string', description: 'pkce-generate | pkce-verify | redirect-validate | redirect-match | auth-request | auth-url | token-request | client-credentials | oidc-discovery | managed-auth | token-info.' },
        verifier: { type: 'string', description: 'PKCE verifier (pkce-verify, token-request).' },
        challenge: { type: 'string', description: 'PKCE challenge (pkce-verify, token-request).' },
        method: { type: 'string', description: 'PKCE method (pkce-verify; must be S256).' },
        length: { type: 'number', description: 'Verifier length for pkce-generate (43–128).' },
        redirectUri: { type: 'string', description: 'Redirect URI (redirect-validate, redirect-match, auth-request, token-request).' },
        registered: { type: 'array', description: 'Registered redirect URIs (redirect-match).' },
        client: { type: 'object', description: 'OAuth client: {clientId, redirectUris, confidential, enterpriseManaged, allowedScopes}.' },
        request: { type: 'object', description: 'Authorization / token / credentials request object (auth-request, auth-url, token-request, client-credentials).' },
        expected: { type: 'object', description: 'Expected values for token-request: {code, redirectUri, codeChallenge, clientId}.' },
        discovery: { type: 'object', description: 'OIDC discovery document (oidc-discovery).' },
        grant: { type: 'object', description: 'Managed authorization grant: {clientId, managedBy, grantedScopes, expiresAtMs?} (managed-auth).' },
        token: { type: 'object', description: 'Token info: {tokenType, scope, expiresIn, issuedAtMs, clientId, enterpriseManaged} (token-info).' },
        scope: { type: 'array', description: 'Scopes to check against a managed grant (managed-auth).' },
        authorizationEndpoint: { type: 'string', description: 'Authorization endpoint (auth-url).' },
        nowMs: { type: 'number', description: 'Clock for expiry checks (token-info, managed-auth).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const now = getOptionalNumberArg(args, 'nowMs') ?? Date.now();
        switch (action) {
          case 'pkce-generate': {
            const length = getOptionalNumberArg(args, 'length') ?? 64;
            const verifier = generateMcpV8PkceVerifier(length);
            return JSON.stringify({ verifier, challenge: mcpV8PkceChallengeS256(verifier), method: 'S256' }, null, 2);
          }
          case 'pkce-verify': {
            const verifier = getStringArg(args, 'verifier');
            const challenge = getStringArg(args, 'challenge');
            const method = getStringArg(args, 'method');
            return JSON.stringify(verifyMcpV8Pkce(verifier, challenge, method), null, 2);
          }
          case 'redirect-validate': {
            const redirectUri = getStringArg(args, 'redirectUri');
            const problems = validateMcpV8RedirectUriShape(redirectUri);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'redirect-match': {
            const redirectUri = getStringArg(args, 'redirectUri');
            const registered = getStringArrayArg(args, 'registered');
            return JSON.stringify({ matched: matchMcpV8RedirectUri(redirectUri, registered) ?? null }, null, 2);
          }
          case 'auth-request': {
            const request = getRecordArg(args, 'request') as unknown as McpV8AuthorizationRequest;
            const client = getRecordArg(args, 'client') as unknown as McpV8OAuthClient;
            const problems = validateMcpV8AuthorizationRequest(request, client);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'auth-url': {
            const request = getRecordArg(args, 'request') as unknown as McpV8AuthorizationRequest;
            const endpoint = getStringArg(args, 'authorizationEndpoint');
            return JSON.stringify({ url: buildMcpV8AuthorizationUrl(endpoint, request) }, null, 2);
          }
          case 'token-request': {
            const request = getRecordArg(args, 'request') as unknown as McpV8TokenRequest;
            const expected = getRecordArg(args, 'expected') as unknown as { code: string; redirectUri: string; codeChallenge: string; clientId: string };
            const problems = validateMcpV8TokenRequest(request, expected);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'client-credentials': {
            const request = getRecordArg(args, 'request') as unknown as McpV8ClientCredentialsRequest;
            const client = getRecordArg(args, 'client') as unknown as McpV8OAuthClient;
            const problems = validateMcpV8ClientCredentials(request, client);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'oidc-discovery': {
            const discovery = getRecordArg(args, 'discovery') as unknown as McpV8OidcDiscovery;
            const problems = validateMcpV8OidcDiscovery(discovery);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'managed-auth': {
            const grant = getRecordArg(args, 'grant') as unknown as { clientId: string; managedBy: string; grantedScopes: string[]; expiresAtMs?: number };
            const problems = validateMcpV8ManagedAuthorization(grant, now);
            const scope = args['scope'] === undefined ? undefined : getStringArrayArg(args, 'scope');
            return JSON.stringify({
              valid: problems.length === 0,
              problems,
              ...(scope !== undefined ? { scopeAllowed: scope.every((s) => grant.grantedScopes.includes(s)) } : {}),
            }, null, 2);
          }
          case 'token-info': {
            const token = getRecordArg(args, 'token') as unknown as McpV8TokenInfo;
            const problems = validateMcpV8TokenInfo(token, now);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          default:
            throw new Error(`Unknown action "${action}". Use pkce-generate | pkce-verify | redirect-validate | redirect-match | auth-request | auth-url | token-request | client-credentials | oidc-discovery | managed-auth | token-info.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const deprecation: Tool = {
    definition: toolDef(
      'protocol_v8_deprecation',
      'Deprecation handling (local action): record a deprecated-feature use (Sampling / Roots / Logging / HTTP+SSE / initialize / session-id header), counts, full report, migration plan, transport check, removal-floor status. Deprecated features still run until 2027-07-28 — every use is warned, none is silent.',
      {
        action: { type: 'string', description: 'record | counts | report | plan | plans | transport | removal | features.' },
        feature: { type: 'string', description: 'Deprecated feature (record, plan): sampling | roots | logging | http-sse-transport | initialize-handshake | mcp-session-id-header.' },
        caller: { type: 'string', description: 'Who used the feature (record).' },
        transport: { type: 'string', description: 'Transport to check (transport): streamable-http | stdio | http-sse.' },
        nowMs: { type: 'number', description: 'Clock for removal status (removal).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const tracker = needDeprecation();
        switch (action) {
          case 'record': {
            const feature = getStringArg(args, 'feature');
            const caller = getStringArg(args, 'caller');
            if (!mcpV8IsDeprecated(feature)) {
              return JSON.stringify({ recorded: false, warning: null, note: `Feature "${feature}" is not deprecated.` }, null, 2);
            }
            const warning: McpV8DeprecationWarning | undefined = tracker.record(feature, caller);
            return JSON.stringify({ recorded: true, warning }, null, 2);
          }
          case 'counts':
            return JSON.stringify({ counts: tracker.countsByFeature(), total: tracker.totalUses() }, null, 2);
          case 'report': {
            return JSON.stringify({ report: buildMcpV8DeprecationReport(tracker) }, null, 2);
          }
          case 'plan': {
            const feature = getStringArg(args, 'feature');
            return JSON.stringify({ plan: mcpV8MigrationPlan(feature) ?? null }, null, 2);
          }
          case 'plans':
            return JSON.stringify({ plans: mcpV8AllMigrationPlans() }, null, 2);
          case 'transport': {
            const transport = getStringArg(args, 'transport');
            return JSON.stringify({ check: checkMcpV8Transport(transport) }, null, 2);
          }
          case 'removal': {
            const now = getOptionalNumberArg(args, 'nowMs');
            return JSON.stringify({ removal: tracker.removalStatus(now) }, null, 2);
          }
          case 'features':
            return JSON.stringify({ features: MCP_V8_DEPRECATIONS }, null, 2);
          default:
            throw new Error(`Unknown action "${action}". Use record | counts | report | plan | plans | transport | removal | features.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nanda: Tool = {
    definition: toolDef(
      'protocol_v8_nanda',
      'NANDA local sketch (local action): create a self-signed Ed25519 agent identity, verify an identity document, announce / discover agents in the local registry (by capability / name / tenant), pin + revoke fingerprints in the local trust store, check trust. No central service is contacted.',
      {
        action: { type: 'string', description: 'identity-create | identity-verify | announce | announce-document | discover-capability | discover-name | discover-tenant | list | get | remove | pin | unpin | revoke | unrevoke | trust-check | sweep.' },
        name: { type: 'string', description: 'Agent name (identity-create, announce, discover-name).' },
        description: { type: 'string', description: 'Agent description (identity-create, announce).' },
        endpoints: { type: 'array', description: 'Endpoints (identity-create, announce).' },
        capabilities: { type: 'array', description: 'Capabilities (identity-create, announce, discover-capability).' },
        document: { type: 'object', description: 'Identity document (identity-verify, announce-document, trust-check).' },
        id: { type: 'string', description: 'Identity id did:openbot:… (announce, get, remove).' },
        fingerprint: { type: 'string', description: 'Fingerprint (announce, pin, unpin, revoke, unrevoke).' },
        tenant: { type: 'string', description: 'Tenant (announce, discover-*).' },
        note: { type: 'string', description: 'Pin note (pin).' },
        reason: { type: 'string', description: 'Revocation reason (revoke).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { registry, trust } = needNanda();
        switch (action) {
          case 'identity-create': {
            const name = getStringArg(args, 'name');
            const description = getStringArg(args, 'description');
            const endpoints = getStringArrayArg(args, 'endpoints');
            const capabilities = getStringArrayArg(args, 'capabilities');
            const identity = McpV8NandaIdentity.create(name, description, endpoints, capabilities);
            return JSON.stringify({ document: identity.document(), id: identity.id(), fingerprint: identity.fingerprint() }, null, 2);
          }
          case 'identity-verify': {
            const document = getRecordArg(args, 'document') as unknown as McpV8NandaIdentityDocument;
            const problems = verifyMcpV8NandaDocument(document);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          case 'announce': {
            const id = getStringArg(args, 'id');
            const name = getStringArg(args, 'name');
            const description = getStringArg(args, 'description');
            const endpoints = getStringArrayArg(args, 'endpoints');
            const capabilities = getStringArrayArg(args, 'capabilities');
            const fingerprint = getStringArg(args, 'fingerprint');
            const tenant = getOptionalStringArg(args, 'tenant');
            const document = args['document'] === undefined
              ? undefined
              : (getRecordArg(args, 'document') as unknown as McpV8NandaIdentityDocument);
            return JSON.stringify({ entry: registry.announce({ id, name, description, endpoints, capabilities, tenant, fingerprint, document }) }, null, 2);
          }
          case 'announce-document': {
            const document = getRecordArg(args, 'document') as unknown as McpV8NandaIdentityDocument;
            const tenant = getOptionalStringArg(args, 'tenant');
            return JSON.stringify({ entry: registry.announceDocument(document, tenant) }, null, 2);
          }
          case 'discover-capability': {
            const capabilities = getStringArrayArg(args, 'capabilities');
            const tenant = getOptionalStringArg(args, 'tenant');
            return JSON.stringify({ entries: registry.discoverByCapability(capabilities, tenant) }, null, 2);
          }
          case 'discover-name': {
            const name = getStringArg(args, 'name');
            const tenant = getOptionalStringArg(args, 'tenant');
            return JSON.stringify({ entries: registry.discoverByName(name, tenant) }, null, 2);
          }
          case 'discover-tenant': {
            const tenant = getStringArg(args, 'tenant');
            return JSON.stringify({ entries: registry.discoverByTenant(tenant) }, null, 2);
          }
          case 'list':
            return JSON.stringify({ entries: registry.all(), size: registry.size() }, null, 2);
          case 'get': {
            const id = getStringArg(args, 'id');
            return JSON.stringify({ entry: registry.get(id) ?? null }, null, 2);
          }
          case 'remove': {
            const id = getStringArg(args, 'id');
            return JSON.stringify({ removed: registry.remove(id) }, null, 2);
          }
          case 'pin': {
            const fingerprint = getStringArg(args, 'fingerprint');
            const note = getOptionalStringArg(args, 'note') ?? '';
            trust.pin(fingerprint, note);
            return JSON.stringify({ pinned: trust.pinnedFingerprints() }, null, 2);
          }
          case 'unpin': {
            const fingerprint = getStringArg(args, 'fingerprint');
            return JSON.stringify({ unpinned: trust.unpin(fingerprint) }, null, 2);
          }
          case 'revoke': {
            const fingerprint = getStringArg(args, 'fingerprint');
            const reason = getOptionalStringArg(args, 'reason') ?? '';
            trust.revoke(fingerprint, reason);
            return JSON.stringify({ revoked: trust.revokedFingerprints() }, null, 2);
          }
          case 'unrevoke': {
            const fingerprint = getStringArg(args, 'fingerprint');
            return JSON.stringify({ unrevoked: trust.unrevoke(fingerprint) }, null, 2);
          }
          case 'trust-check': {
            const document = getRecordArg(args, 'document') as unknown as McpV8NandaIdentityDocument;
            const problems = trust.checkDocument(document);
            return JSON.stringify({ trusted: problems.length === 0, problems }, null, 2);
          }
          case 'sweep':
            return JSON.stringify({ swept: registry.sweepExpired() }, null, 2);
          default:
            throw new Error(`Unknown action "${action}". Use identity-create | identity-verify | announce | announce-document | discover-capability | discover-name | discover-tenant | list | get | remove | pin | unpin | revoke | unrevoke | trust-check | sweep.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const serverCard: Tool = {
    definition: toolDef(
      'protocol_v8_server_card',
      'Server Cards (read): build a Server Card discovery document from a NANDA registry entry, or validate a card structurally. A card lets a client discover a server without a prior handshake.',
      {
        action: { type: 'string', description: 'build | validate.' },
        id: { type: 'string', description: 'Registry entry id (build).' },
        card: { type: 'object', description: 'Server Card to validate (validate).' },
        protocolVersion: { type: 'string', description: 'Protocol version for the card (build).' },
        extensions: { type: 'array', description: 'Extensions for the card (build).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { registry } = needNanda();
        switch (action) {
          case 'build': {
            const id = getStringArg(args, 'id');
            const entry = registry.get(id);
            if (entry === undefined) throw new Error(`Registry entry "${id}" is not known.`);
            const protocolVersion = getOptionalStringArg(args, 'protocolVersion');
            const extensions = args['extensions'] === undefined ? undefined : getStringArrayArg(args, 'extensions');
            return JSON.stringify({ card: buildMcpV8ServerCard(entry, { ...(protocolVersion !== undefined ? { protocolVersion } : {}), ...(extensions !== undefined ? { extensions } : {}) }) }, null, 2);
          }
          case 'validate': {
            const card = getRecordArg(args, 'card') as unknown as McpV8ServerCard;
            const problems = validateMcpV8ServerCard(card);
            return JSON.stringify({ valid: problems.length === 0, problems }, null, 2);
          }
          default:
            throw new Error(`Unknown action "${action}". Use build | validate.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skills: Tool = {
    definition: toolDef(
      'protocol_v8_skills',
      'Skills over MCP (local action): register a skill pack (validated: name, semver, body size, asset paths), list tier-1 metadata (cheap startup list), fetch the body (tier 2) or an asset (tier 3) on demand, read any skill:// URI, search, unregister.',
      {
        action: { type: 'string', description: 'register | list | metadata | body | asset | read | search | unregister | uris.' },
        pack: { type: 'object', description: 'Skill pack: {name, version, description, body, allowedTools?, argumentHint?, scripts?, assets?} (register).' },
        name: { type: 'string', description: 'Skill name (metadata, body, asset, unregister).' },
        assetPath: { type: 'string', description: 'Asset path inside the pack (asset).' },
        uri: { type: 'string', description: 'skill:// URI (read).' },
        query: { type: 'string', description: 'Search query (search).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const registry = needSkills();
        switch (action) {
          case 'register': {
            const pack = getRecordArg(args, 'pack') as unknown as McpV8SkillPack;
            const problems = validateMcpV8SkillPack(pack);
            if (problems.length > 0) throw new Error(`Invalid skill pack: ${problems.join('; ')}`);
            return JSON.stringify({ metadata: registry.register(pack) }, null, 2);
          }
          case 'list':
            return JSON.stringify({ skills: registry.listMetadata(), count: registry.size() }, null, 2);
          case 'metadata': {
            const name = getStringArg(args, 'name');
            return JSON.stringify({ metadata: registry.metadata(name) ?? null }, null, 2);
          }
          case 'body': {
            const name = getStringArg(args, 'name');
            const body = registry.body(name);
            if (body === undefined) throw new Error(`Skill "${name}" is not registered.`);
            return JSON.stringify({ name, uri: mcpV8SkillBodyUri(name), body }, null, 2);
          }
          case 'asset': {
            const name = getStringArg(args, 'name');
            const assetPath = getStringArg(args, 'assetPath');
            const asset = registry.asset(name, assetPath);
            if (asset === undefined) throw new Error(`Asset "${assetPath}" is not part of skill "${name}".`);
            return JSON.stringify({ asset }, null, 2);
          }
          case 'read': {
            const uri = getStringArg(args, 'uri');
            return JSON.stringify(registry.read(uri), null, 2);
          }
          case 'search': {
            const query = getStringArg(args, 'query');
            return JSON.stringify({ skills: registry.search(query) }, null, 2);
          }
          case 'unregister': {
            const name = getStringArg(args, 'name');
            return JSON.stringify({ unregistered: registry.unregister(name) }, null, 2);
          }
          case 'uris':
            return JSON.stringify({ uris: registry.resourceUris() }, null, 2);
          default:
            throw new Error(`Unknown action "${action}". Use register | list | metadata | body | asset | read | search | unregister | uris.`);
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [discover, versions, extensions, stateless, legacy, apps, tasks, oauth, deprecation, nanda, serverCard, skills];
}

/** Unbound placeholder (the host binds state via createProtocolV116Tools). */
export const PROTOCOL_V116_TOOLS: Tool[] = createProtocolV116Tools();

export const PROTOCOL_V116_TOOL_NAMES = [
  'protocol_v8_discover',
  'protocol_v8_versions',
  'protocol_v8_extensions',
  'protocol_v8_stateless',
  'protocol_v8_legacy',
  'protocol_v8_apps',
  'protocol_v8_tasks',
  'protocol_v8_oauth',
  'protocol_v8_deprecation',
  'protocol_v8_nanda',
  'protocol_v8_server_card',
  'protocol_v8_skills',
] as const;

export type ProtocolV116ToolName = (typeof PROTOCOL_V116_TOOL_NAMES)[number];

export function isProtocolV116ToolName(name: string): name is ProtocolV116ToolName {
  return (PROTOCOL_V116_TOOL_NAMES as readonly string[]).includes(name);
}
