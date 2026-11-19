/**
 * Protocols v10 tools for @open-bot/tools (v1.41, Team T2).
 *
 * The agent drives the protocols-v10 stack by tool call:
 *  - protocol_v10_versions      — version matrix / changes since v9 / downgrade to v9 / negotiate / feature flags (read)
 *  - protocol_v10_stateless     — MCP stateless v10 over a loopback server: discover / tools list+call / subscribe / state handles / trace (local action)
 *  - protocol_v10_oauth         — issuer validation (RFC 9207) / token validation + binding / DCR gate / Client ID Metadata Documents / auth-server metadata (read)
 *  - protocol_v10_tool_search   — registry: register / search / load / stats / promotion candidates / snapshot / restore (local action)
 *  - protocol_v10_script        — programmatic tool calling: validate + run a script of tool calls, only the final result returns (local action)
 *  - protocol_v10_tasks         — Tasks extension v10: create / get / list / ready / progress / request-input / provide-input / complete / fail / cancel / counts / events / snapshot / restore / sweep (local action)
 *  - protocol_v10_apps          — MCP Apps v10: validate resource / build CSP / validate bridge message (read)
 *  - protocol_v10_apps_bridge   — postMessage bridge: open / initialize / call / notify / close / audit / snapshot (local action)
 *  - protocol_v10_roundtrip     — multi round-trip: validate request / validate answer / run a demo loop with scripted answers (local action)
 *  - protocol_v10_a2a           — A2A v1.0 minimal handshake: validate card / well-known URL / negotiate / handshake / message (local action, loopback-only)
 *  - protocol_v10_deprecation   — deprecation registry: list / register / use / check-removal / remove / removable-now / defaults (local action)
 *  - protocol_v10_registry      — unified registry: counts across versions, stateless, search, tasks, apps, deprecations (read)
 *
 * Factory:
 *   createProtocolV118Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V118_TOOLS                       (unbound placeholder)
 *
 * State: when the host does not bind its own stores, the factory
 * creates one shared in-memory set (stateless server, search
 * registry, task engine, app bridge, deprecation registry) and
 * shares it across the 12 tools, so the tools work standalone.
 * The host may override any piece via ProtocolV118ToolOptions.
 *
 * SAFETY: the tools never carry credentials (tokens are opaque
 * values the host supplies for validation only; the DCR gate
 * refuses dynamic registration by default), never write to disk
 * by themselves (registries and stores are in-memory; the host
 * mirrors snapshots), and never open a network connection (the
 * A2A handshake is loopback-only and the loopback guard refuses
 * any other URL before anything is sent; the stateless client
 * runs over an in-process loopback server unless the host binds
 * its own sender).
 */
import type { Tool } from '@open-bot/core';
import {
  A2aV10Session,
  McpV10AppBridge,
  McpV10DeprecationRegistry,
  McpV10ProgrammaticCaller,
  McpV10RoundTripLoop,
  McpV10StatelessClient,
  McpV10StatelessServer,
  McpV10TaskEngine,
  McpV10TaskStore,
  McpV10ToolSearchRegistry,
  buildA2aV10WellKnownUrl,
  buildMcpV10AppCsp,
  buildMcpV10InputRequiredResult,
  checkMcpV10TokenBinding,
  createLoopbackMcpV10Sender,
  defaultMcpV10Deprecations,
  isA2aV10LoopbackUrl,
  mcpV10DaysBetween,
  mcpV10EarliestRemovalDate,
  mcpV10TodayIso,
  mcpV10TokenBindingFingerprint,
  negotiateA2aV10Version,
  negotiateAllProtocolsV10,
  negotiateProtocolV10Version,
  protocolV10ChangesSinceV9,
  protocolV10DowngradeToV9,
  protocolV10MatrixSummary,
  validateA2aV10AgentCard,
  validateMcpV10AppResource,
  validateMcpV10AuthServerMetadata,
  validateMcpV10BridgeMessage,  validateMcpV10ClientIdMetadataDocument,
  validateMcpV10ExplicitClient,
  validateMcpV10InputAnswer,
  validateMcpV10InputRequest,
  validateMcpV10IssuerUrl,
  validateMcpV10TokenForServer,
  validateMcpV10TokenIssuer,
  validateProtocolV10Features,
  PROTOCOL_V10_CURRENT_VERSIONS,
  PROTOCOL_V10_DEFAULT_FEATURES,
  PROTOCOL_V10_VERSION_MATRIX,
  type McpV10SearchableTool,
  type McpV10TaskPriority,
  type McpV10Token,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function parseTokenArg(args: Record<string, unknown>): McpV10Token {
  const raw = getRecordArg(args, 'token');
  const value = getStringArg(raw, 'value');
  const issuer = getStringArg(raw, 'issuer');
  const audience = raw.audience;
  if (typeof audience !== 'string' && !Array.isArray(audience)) {
    throw new Error('token.audience must be a string or an array of strings.');
  }
  return {
    value,
    issuer,
    audience: audience as string | string[],
    tokenId: getOptionalStringArg(raw, 'tokenId'),
    expiresAtSec: getOptionalNumberArg(raw, 'expiresAtSec'),
    scope: getOptionalStringArg(raw, 'scope'),
  };
}

/** Options for the v10 tools (host bindings). */
export interface ProtocolV118ToolOptions {
  /** Stateless server accessor (the host binds its server). */
  getStatelessServer?: () => McpV10StatelessServer | null;
  /** Tool-search registry accessor (the host binds its registry). */
  getToolSearchRegistry?: () => McpV10ToolSearchRegistry | null;
  /** Task engine accessor (the host binds its engine). */
  getTaskEngine?: () => McpV10TaskEngine | null;
  /** App bridge accessor (the host binds its bridge). */
  getAppBridge?: () => McpV10AppBridge | null;
  /** Deprecation registry accessor (the host binds its registry). */
  getDeprecationRegistry?: () => McpV10DeprecationRegistry | null;
}

export function createProtocolV118Tools(opts: ProtocolV118ToolOptions = {}): Tool[] {
  let fallbackServer: McpV10StatelessServer | null = null;
  let fallbackSearch: McpV10ToolSearchRegistry | null = null;
  let fallbackTasks: McpV10TaskEngine | null = null;
  let fallbackBridge: McpV10AppBridge | null = null;
  let fallbackDeprecations: McpV10DeprecationRegistry | null = null;

  const needServer = (): McpV10StatelessServer => {
    if (opts.getStatelessServer?.()) return opts.getStatelessServer() as McpV10StatelessServer;
    if (!fallbackServer) {
      fallbackServer = new McpV10StatelessServer({
        tools: [
          {
            name: 'echo',
            description: 'Echo the arguments back (demo tool for the loopback server).',
            handler: (args) => ({ echoed: args }),
          },
        ],
      });
    }
    return fallbackServer;
  };
  const needSearch = (): McpV10ToolSearchRegistry => {
    if (opts.getToolSearchRegistry?.()) return opts.getToolSearchRegistry() as McpV10ToolSearchRegistry;
    if (!fallbackSearch) {
      fallbackSearch = new McpV10ToolSearchRegistry([
        { name: 'protocol_v10_versions', description: 'Show the protocols v10 version matrix.', category: 'protocols', deferLoading: false, keywords: ['version', 'matrix'] },
        { name: 'protocol_v10_stateless', description: 'Drive the MCP stateless v10 client.', category: 'protocols', deferLoading: true, keywords: ['stateless', 'discover'] },
        { name: 'protocol_v10_oauth', description: 'Validate OAuth tokens and issuers (RFC 9207).', category: 'protocols', deferLoading: true, keywords: ['oauth', 'issuer', 'token'] },
        { name: 'protocol_v10_tasks', description: 'Create and poll long-running MCP Tasks.', category: 'protocols', deferLoading: true, keywords: ['tasks', 'long-running'] },
        { name: 'protocol_v10_apps_bridge', description: 'Bridge MCP Apps UI calls through the host.', category: 'protocols', deferLoading: true, keywords: ['apps', 'bridge', 'ui'] },
      ]);
    }
    return fallbackSearch;
  };
  const needTasks = (): McpV10TaskEngine => {
    if (opts.getTaskEngine?.()) return opts.getTaskEngine() as McpV10TaskEngine;
    if (!fallbackTasks) {
      const store = new McpV10TaskStore();
      fallbackTasks = new McpV10TaskEngine(store);
      fallbackTasks.registerHandler('echo', (task) => ({ echoed: task.args }));
    }
    return fallbackTasks;
  };
  const needBridge = (): McpV10AppBridge => {
    if (opts.getAppBridge?.()) return opts.getAppBridge() as McpV10AppBridge;
    if (!fallbackBridge) fallbackBridge = new McpV10AppBridge();
    return fallbackBridge;
  };
  const needDeprecations = (): McpV10DeprecationRegistry => {
    if (opts.getDeprecationRegistry?.()) return opts.getDeprecationRegistry() as McpV10DeprecationRegistry;
    if (!fallbackDeprecations) {
      fallbackDeprecations = new McpV10DeprecationRegistry();
      for (const entry of defaultMcpV10Deprecations()) fallbackDeprecations.deprecate(entry);
    }
    return fallbackDeprecations;
  };

  const versions: Tool = {
    definition: {
      name: 'protocol_v10_versions',
      description: 'Protocols v10 version matrix: current versions per family, changes since v9, downgrade to v9, negotiate versions, feature flags. READ-ONLY, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'matrix | changes | downgrade | negotiate | negotiate-all | flags | summary' },
          family: { type: 'string', description: 'Protocol family for negotiate (a2a | mcp | ucp | acp | gov | agui | a2ui | poppy | nanda).' },
          peerVersions: { type: 'string', description: 'Comma-separated peer versions for negotiate.' },
          offered: { type: 'object', description: 'Map family -> comma-separated versions for negotiate-all.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'matrix':
            return okResult({ current: PROTOCOL_V10_CURRENT_VERSIONS, matrix: PROTOCOL_V10_VERSION_MATRIX });
          case 'changes':
            return okResult({ changes: protocolV10ChangesSinceV9() });
          case 'downgrade':
            return okResult({ downgrade: protocolV10DowngradeToV9() });
          case 'negotiate': {
            const family = getStringArg(args, 'family') as keyof typeof PROTOCOL_V10_CURRENT_VERSIONS;
            const peer = getStringArg(args, 'peerVersions').split(',').map((v) => v.trim()).filter(Boolean);
            return okResult(negotiateProtocolV10Version(family, peer));
          }
          case 'negotiate-all': {
            const offeredRaw = getRecordArg(args, 'offered');
            const offered: Record<string, string[]> = {};
            for (const [k, v] of Object.entries(offeredRaw)) {
              offered[k] = typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
            }
            return okResult(negotiateAllProtocolsV10(offered as never));
          }
          case 'flags':
            return okResult({ defaults: PROTOCOL_V10_DEFAULT_FEATURES, problems: validateProtocolV10Features(PROTOCOL_V10_DEFAULT_FEATURES) });
          case 'summary':
            return okResult({ summary: protocolV10MatrixSummary() });
          default:
            throw new Error('Unknown action "' + action + '". Use matrix | changes | downgrade | negotiate | negotiate-all | flags | summary.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stateless: Tool = {
    definition: {
      name: 'protocol_v10_stateless',
      description: 'MCP stateless v10 over the loopback server: discover / tools list+call / subscribe to subscriptions/listen / state handles / trace. LOCAL action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'discover | list | call | subscribe | sweep-handles | counts' },
          tool: { type: 'string', description: 'Tool name for call.' },
          arguments: { type: 'object', description: 'Tool arguments for call.' },
          listenerId: { type: 'string', description: 'Listener id for subscribe.' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Notification kinds for subscribe (tools | resources | prompts | tasks | apps).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const server = needServer();
        const client = new McpV10StatelessClient({ sender: createLoopbackMcpV10Sender(server) });
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'discover':
            return okResult(await client.discover());
          case 'list':
            return okResult(await client.listTools());
          case 'call': {
            const tool = getStringArg(args, 'tool');
            const callArgs = args.arguments === undefined ? {} : getRecordArg(args, 'arguments');
            return okResult({ result: await client.callTool(tool, callArgs), stateHandle: client.currentStateHandle ?? null });
          }
          case 'subscribe': {
            const listenerId = getStringArg(args, 'listenerId');
            const kinds = getStringArrayArg(args, 'kinds') as Array<'tools' | 'resources' | 'prompts' | 'tasks' | 'apps'>;
            return okResult(await client.subscribe(listenerId, kinds));
          }
          case 'sweep-handles':
            return okResult({ swept: server.sweepHandles() });
          case 'counts':
            return okResult({ totalCalls: server.totalCalls, subscriptions: server.subscriptions.countsByKind(), delivered: server.subscriptions.delivered.length, dropped: server.subscriptions.dropped.length });
          default:
            throw new Error('Unknown action "' + action + '". Use discover | list | call | subscribe | sweep-handles | counts.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const oauth: Tool = {
    definition: {
      name: 'protocol_v10_oauth',
      description: 'OAuth v10: validate a token issuer (RFC 9207), validate a token for a server (issuer + audience + scopes + expiry), check token binding, validate explicit clients / Client ID Metadata Documents / auth-server metadata. READ-ONLY, no network, tokens stay opaque.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-issuer | validate-token | binding-fingerprint | check-binding | validate-client | validate-metadata-document | validate-auth-server | dcr-status' },
          tokenIssuer: { type: 'string', description: 'Token iss claim for validate-issuer.' },
          expectedIssuer: { type: 'string', description: 'Expected issuer URL.' },
          token: { type: 'object', description: 'Token object {value, issuer, audience, tokenId?, expiresAtSec?, scope?} for validate-token / binding.' },
          server: { type: 'object', description: 'Server identity {issuer, audience, requiredScopes?} for validate-token.' },
          fingerprint: { type: 'string', description: 'Recorded binding fingerprint for check-binding.' },
          client: { type: 'object', description: 'Explicit client registration for validate-client.' },
          document: { type: 'object', description: 'Client ID Metadata Document for validate-metadata-document.' },
          metadata: { type: 'object', description: 'Authorization-server metadata for validate-auth-server.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'validate-issuer': {
            const tokenIssuer = getStringArg(args, 'tokenIssuer');
            const expectedIssuer = getStringArg(args, 'expectedIssuer');
            return okResult(validateMcpV10TokenIssuer(tokenIssuer, expectedIssuer));
          }
          case 'validate-token': {
            const token = parseTokenArg(args);
            const server = getRecordArg(args, 'server');
            return okResult(validateMcpV10TokenForServer(token, {
              issuer: getStringArg(server, 'issuer'),
              audience: getStringArg(server, 'audience'),
              requiredScopes: server.requiredScopes === undefined ? undefined : getStringArrayArg(server, 'requiredScopes'),
            }));
          }
          case 'binding-fingerprint': {
            const token = parseTokenArg(args);
            return okResult({ fingerprint: mcpV10TokenBindingFingerprint(token) });
          }
          case 'check-binding': {
            const token = parseTokenArg(args);
            const fingerprint = getStringArg(args, 'fingerprint');
            return okResult(checkMcpV10TokenBinding(token, fingerprint));
          }
          case 'validate-client':
            return okResult({ problems: validateMcpV10ExplicitClient(getRecordArg(args, 'client')) });
          case 'validate-metadata-document':
            return okResult({ problems: validateMcpV10ClientIdMetadataDocument(getRecordArg(args, 'document')) });
          case 'validate-auth-server':
            return okResult({ problems: validateMcpV10AuthServerMetadata(getRecordArg(args, 'metadata')) });
          case 'dcr-status':
            return okResult({ status: 'deprecated', deprecatedSince: '2026-07-28', earliestRemoval: '2027-07-28', replacement: 'explicit registration / Client ID Metadata Documents' });
          default:
            throw new Error('Unknown action "' + action + '". Use validate-issuer | validate-token | binding-fingerprint | check-binding | validate-client | validate-metadata-document | validate-auth-server | dcr-status.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolSearch: Tool = {
    definition: {
      name: 'protocol_v10_tool_search',
      description: 'Tool search (defer_loading): register a tool, search the registry, load a deferred tool on demand, load stats, promotion candidates, snapshot/restore. LOCAL action.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'register | search | load | load-many | stats | deferred-stats | promotions | categories | snapshot | restore | counts' },
          tool: { type: 'object', description: 'Tool {name, description, category, deferLoading, keywords?} for register.' },
          query: { type: 'string', description: 'Search query for search.' },
          name: { type: 'string', description: 'Tool name for load / stats.' },
          names: { type: 'array', items: { type: 'string' }, description: 'Tool names for load-many.' },
          limit: { type: 'number', description: 'Max search hits (default 10).' },
          category: { type: 'string', description: 'Category filter for search.' },
          snapshot: { type: 'object', description: 'Snapshot {tools, loaded} for restore.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const registry = needSearch();
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'register': {
            const raw = getRecordArg(args, 'tool');
            const tool: McpV10SearchableTool = {
              name: getStringArg(raw, 'name'),
              description: getStringArg(raw, 'description'),
              category: getStringArg(raw, 'category'),
              deferLoading: raw.deferLoading === true,
              keywords: raw.keywords === undefined ? undefined : getStringArrayArg(raw, 'keywords'),
            };
            registry.register(tool);
            return okResult({ registered: tool.name, total: registry.total });
          }
          case 'search': {
            const query = getStringArg(args, 'query');
            const limit = getOptionalNumberArg(args, 'limit');
            const category = getOptionalStringArg(args, 'category');
            return okResult({ hits: registry.search(query, { limit, category }) });
          }
          case 'load': {
            const name = getStringArg(args, 'name');
            return okResult(await registry.loadTool(name));
          }
          case 'load-many': {
            const names = getStringArrayArg(args, 'names');
            return okResult(await registry.loadTools(names));
          }
          case 'stats': {
            const name = getStringArg(args, 'name');
            const stats = registry.loadStats(name);
            if (!stats) throw new Error(`Unknown tool "${name}".`);
            return okResult(stats);
          }
          case 'deferred-stats':
            return okResult({ deferred: registry.deferredStats() });
          case 'promotions':
            return okResult({ candidates: registry.promotionCandidates(getOptionalNumberArg(args, 'limit') ?? 3) });
          case 'categories':
            return okResult({ categories: registry.categories() });
          case 'snapshot':
            return okResult(registry.snapshot());
          case 'restore': {
            const snap = getRecordArg(args, 'snapshot');
            const restored = McpV10ToolSearchRegistry.restore(snap as { tools: McpV10SearchableTool[]; loaded: string[] });
            return okResult({ total: restored.total, loaded: restored.loadedCount });
          }
          case 'counts':
            return okResult({ total: registry.total, deferred: registry.deferredCount, loaded: registry.loadedCount });
          default:
            throw new Error('Unknown action "' + action + '". Use register | search | load | load-many | stats | deferred-stats | promotions | categories | snapshot | restore | counts.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const script: Tool = {
    definition: {
      name: 'protocol_v10_script',
      description: 'Programmatic tool calling: validate + run a script of tool calls (steps with $variable references); only the final result + compact step log return to the context. LOCAL action.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate | run' },
          script: { type: 'object', description: 'Script {name, steps: [{tool, args?, saveAs?}], maxSteps?, stepTimeoutMs?}.' },
        },
        required: ['action', 'script'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const rawScript = getRecordArg(args, 'script');
        const scriptDef = {
          name: getStringArg(rawScript, 'name'),
          steps: (rawScript.steps as Array<Record<string, unknown>>).map((s) => ({
            tool: getStringArg(s, 'tool'),
            args: s.args === undefined ? undefined : getRecordArg(s, 'args'),
            saveAs: getOptionalStringArg(s, 'saveAs'),
          })),
          maxSteps: getOptionalNumberArg(rawScript, 'maxSteps'),
          stepTimeoutMs: getOptionalNumberArg(rawScript, 'stepTimeoutMs'),
        };
        const registry = needSearch();
        const caller = new McpV10ProgrammaticCaller(registry, (tool, callArgs) => {
          // Demo executor: echo the call (the host binds the real executor).
          return { tool, args: callArgs };
        });
        if (action === 'validate') return okResult({ problems: caller.validate(scriptDef) });
        if (action === 'run') return okResult(await caller.run(scriptDef));
        throw new Error('Unknown action "' + action + '". Use validate | run.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tasks: Tool = {
    definition: {
      name: 'protocol_v10_tasks',
      description: 'Tasks extension v10: create / get / list / ready queue / run-next / progress / request-input / provide-input / complete / fail / cancel / counts / events / snapshot / restore / sweep. LOCAL action.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create | get | list | ready | run-next | progress | request-input | provide-input | complete | fail | cancel | counts | events | snapshot | restore | sweep' },
          toolName: { type: 'string', description: 'Tool name for create.' },
          taskArgs: { type: 'object', description: 'Task arguments for create.' },
          priority: { type: 'string', description: 'Task priority (low | normal | high | urgent) for create.' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Dependency task ids for create.' },
          maxRetries: { type: 'number', description: 'Max retries for create.' },
          id: { type: 'string', description: 'Task id for get / progress / input / complete / fail / cancel.' },
          progress: { type: 'number', description: 'Progress 0-100 for progress.' },
          message: { type: 'string', description: 'Progress message / cancel reason.' },
          request: { type: 'object', description: 'Input request {reason, fields} for request-input.' },
          response: { type: 'object', description: 'Input answer for provide-input.' },
          result: { type: 'object', description: 'Final result for complete.' },
          error: { type: 'string', description: 'Failure message for fail.' },
          snapshot: { type: 'array', items: { type: 'object' }, description: 'Task snapshots for restore.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const engine = needTasks();
        const store = engine.store;
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'create': {
            const task = engine.submit({
              toolName: getStringArg(args, 'toolName'),
              args: args.taskArgs === undefined ? {} : getRecordArg(args, 'taskArgs'),
              priority: (getOptionalStringArg(args, 'priority') ?? 'normal') as McpV10TaskPriority,
              dependsOn: args.dependsOn === undefined ? undefined : getStringArrayArg(args, 'dependsOn'),
              retryPolicy: getOptionalNumberArg(args, 'maxRetries') === undefined ? undefined : { maxRetries: getOptionalNumberArg(args, 'maxRetries') as number },
            });
            return okResult(task);
          }
          case 'get': {
            const task = store.get(getStringArg(args, 'id'));
            if (!task) throw new Error(`Unknown task "${getStringArg(args, 'id')}".`);
            return okResult(task);
          }
          case 'list':
            return okResult({ tasks: store.list() });
          case 'ready':
            return okResult({ ready: store.readyQueue() });
          case 'run-next': {
            const done = await engine.runNext();
            return okResult(done ?? { ran: false, reason: 'No ready task.' });
          }
          case 'progress':
            return okResult(store.reportProgress(getStringArg(args, 'id'), getOptionalNumberArg(args, 'progress') ?? 0, getOptionalStringArg(args, 'message')));
          case 'request-input':
            return okResult(store.requestInput(getStringArg(args, 'id'), getRecordArg(args, 'request')));
          case 'provide-input':
            return okResult(store.provideInput(getStringArg(args, 'id'), getRecordArg(args, 'response')));
          case 'complete':
            return okResult(store.complete(getStringArg(args, 'id'), args.result ?? null));
          case 'fail':
            return okResult(store.fail(getStringArg(args, 'id'), getStringArg(args, 'error')));
          case 'cancel':
            return okResult(store.cancel(getStringArg(args, 'id'), getOptionalStringArg(args, 'message')));
          case 'counts':
            return okResult(store.counts());
          case 'events':
            return okResult({ events: store.eventsFor(getOptionalStringArg(args, 'id')) });
          case 'snapshot':
            return okResult({ tasks: store.snapshot() });
          case 'restore': {
            const snaps = args.snapshot as unknown[];
            if (!Array.isArray(snaps)) throw new Error('snapshot must be an array of task snapshots.');
            store.restore(snaps as never);
            return okResult({ restored: store.list().length });
          }
          case 'sweep':
            return okResult({ swept: store.sweepOverdue() });
          default:
            throw new Error('Unknown action "' + action + '". Use create | get | list | ready | run-next | progress | request-input | provide-input | complete | fail | cancel | counts | events | snapshot | restore | sweep.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const apps: Tool = {
    definition: {
      name: 'protocol_v10_apps',
      description: 'MCP Apps v10: validate an app resource (ui:// + text/html;profile=mcp-app), build its strict CSP from declared domains, validate a postMessage bridge message. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-resource | csp | validate-message' },
          resource: { type: 'object', description: 'App resource {uri, mimeType, html, domains, allowedTools?}.' },
          hostOrigin: { type: 'string', description: 'Host origin for csp (e.g. app://open-bot).' },
          message: { type: 'object', description: 'Bridge message for validate-message.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'validate-resource': {
            return okResult({ problems: validateMcpV10AppResource(getRecordArg(args, 'resource')) });
          }
          case 'csp': {
            const resource = getRecordArg(args, 'resource');
            const hostOrigin = getStringArg(args, 'hostOrigin');
            return okResult({ csp: buildMcpV10AppCsp(resource as never, hostOrigin) });
          }
          case 'validate-message':
            return okResult({ problems: validateMcpV10BridgeMessage(getRecordArg(args, 'message')) });
          default:
            throw new Error('Unknown action "' + action + '". Use validate-resource | csp | validate-message.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appsBridge: Tool = {
    definition: {
      name: 'protocol_v10_apps_bridge',
      description: 'MCP Apps v10 postMessage bridge: open a session, run the ui/initialize handshake, relay tools/call through the host arbiter, notify, close, audit. LOCAL action; the UI is untrusted, the host arbitrates.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'open | initialize | call | notify | close | audit | snapshot | list' },
          appId: { type: 'string', description: 'App instance id.' },
          uri: { type: 'string', description: 'ui:// resource URI for open.' },
          toolName: { type: 'string', description: 'Tool the UI belongs to, for open.' },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Allowlisted tools for open.' },
          expectedOrigin: { type: 'string', description: 'Expected postMessage origin for open.' },
          capabilities: { type: 'object', description: 'UI capabilities {bridgeVersions, ...} for initialize.' },
          origin: { type: 'string', description: 'PostMessage origin for initialize / call / notify.' },
          tool: { type: 'string', description: 'Tool name for call.' },
          arguments: { type: 'object', description: 'Tool arguments for call.' },
          message: { type: 'string', description: 'Notification message for notify.' },
          id: { type: 'string', description: 'JSON-RPC id for initialize / call.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const bridge = needBridge();
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'open': {
            const session = bridge.open({
              appId: getStringArg(args, 'appId'),
              uri: getStringArg(args, 'uri'),
              toolName: getStringArg(args, 'toolName'),
              allowedTools: args.allowedTools === undefined ? [] : getStringArrayArg(args, 'allowedTools'),
              expectedOrigin: getOptionalStringArg(args, 'expectedOrigin'),
              executor: (tool, callArgs) => ({ tool, args: callArgs, relayed: true }),
            });
            return okResult(session.snapshot());
          }
          case 'initialize': {
            const appId = getStringArg(args, 'appId');
            const caps = getRecordArg(args, 'capabilities');
            const id = getStringArg(args, 'id', false) || 'init-1';
            const origin = getStringArg(args, 'origin', false) || '';
            const reply = await bridge.routeMessage(appId, { jsonrpc: '2.0', id, method: 'ui/initialize', params: { capabilities: caps } }, origin);
            if (!reply) throw new Error(`Unknown app "${appId}".`);
            return okResult(reply);
          }
          case 'call': {
            const appId = getStringArg(args, 'appId');
            const id = getStringArg(args, 'id', false) || 'call-1';
            const origin = getStringArg(args, 'origin', false) || '';
            const reply = await bridge.routeMessage(
              appId,
              { jsonrpc: '2.0', id, method: 'tools/call', params: { name: getStringArg(args, 'tool'), arguments: args.arguments === undefined ? {} : getRecordArg(args, 'arguments') } },
              origin,
            );
            if (!reply) throw new Error(`Unknown app "${appId}".`);
            return okResult(reply);
          }
          case 'notify': {
            const appId = getStringArg(args, 'appId');
            const origin = getStringArg(args, 'origin', false) || '';
            await bridge.routeMessage(appId, { jsonrpc: '2.0', method: 'ui/notify', params: { message: getStringArg(args, 'message') } }, origin);
            return okResult({ notified: true });
          }
          case 'close':
            return okResult({ closed: bridge.close(getStringArg(args, 'appId')) });
          case 'audit': {
            const session = bridge.get(getStringArg(args, 'appId'));
            if (!session) throw new Error(`Unknown app "${getStringArg(args, 'appId')}".`);
            return okResult({ audit: session.auditLog(), calls: session.totalCalls, rejected: session.totalRejected });
          }
          case 'snapshot': {
            const session = bridge.get(getStringArg(args, 'appId'));
            if (!session) throw new Error(`Unknown app "${getStringArg(args, 'appId')}".`);
            return okResult(session.snapshot());
          }
          case 'list':
            return okResult({ sessions: bridge.list().map((s) => s.snapshot()) });
          default:
            throw new Error('Unknown action "' + action + '". Use open | initialize | call | notify | close | audit | snapshot | list.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const roundtrip: Tool = {
    definition: {
      name: 'protocol_v10_roundtrip',
      description: 'Multi round-trip v10: validate an input_required request, validate an answer against it, or run a demo loop (a scripted handler asks for input, scripted answers reply). LOCAL action.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-request | validate-answer | run-demo' },
          request: { type: 'object', description: 'Input request {reason, fields} for validate-request / validate-answer.' },
          answer: { type: 'object', description: 'Answer object for validate-answer.' },
          rounds: { type: 'number', description: 'How many input rounds the demo loop runs (default 2, max 5).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'validate-request':
            return okResult({ problems: validateMcpV10InputRequest(getRecordArg(args, 'request')) });
          case 'validate-answer':
            return okResult(validateMcpV10InputAnswer(getRecordArg(args, 'request') as never, getRecordArg(args, 'answer')));
          case 'run-demo': {
            const wanted = getOptionalNumberArg(args, 'rounds') ?? 2;
            const loop = new McpV10RoundTripLoop();
            let asked = 0;
            const outcome = await loop.run(
              (answers) => {
                if (asked < wanted) {
                  asked += 1;
                  return buildMcpV10InputRequiredResult({
                    reason: `Demo round ${asked}: the handler needs one more field.`,
                    fields: [{ name: `field${asked}`, type: 'string', required: true, prompt: `Value for field${asked}` }],
                  });
                }
                return { done: true, answers };
              },
              (request) => {
                const answer: Record<string, unknown> = {};
                for (const field of request.fields) answer[field.name] = `demo-${field.name}`;
                return answer;
              },
            );
            return okResult(outcome);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use validate-request | validate-answer | run-demo.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2a: Tool = {
    definition: {
      name: 'protocol_v10_a2a',
      description: 'A2A v1.0 minimal handshake: validate an Agent Card, build its well-known URL, negotiate the version, run a loopback-only handshake + text message exchange. LOCAL action; non-loopback URLs are refused.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-card | well-known | negotiate | handshake | message' },
          card: { type: 'object', description: 'Agent Card for validate-card / handshake.' },
          baseUrl: { type: 'string', description: 'Loopback base URL for well-known / handshake.' },
          peerVersions: { type: 'string', description: 'Comma-separated peer versions for negotiate.' },
          capabilities: { type: 'array', items: { type: 'string' }, description: 'Local capabilities for handshake.' },
          authSchemes: { type: 'array', items: { type: 'string' }, description: 'Local auth schemes for handshake.' },
          text: { type: 'string', description: 'Message text for message.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'validate-card':
            return okResult({ problems: validateA2aV10AgentCard(getRecordArg(args, 'card')) });
          case 'well-known':
            return okResult({ url: buildA2aV10WellKnownUrl(getStringArg(args, 'baseUrl')) });
          case 'negotiate': {
            const peer = getStringArg(args, 'peerVersions').split(',').map((v) => v.trim()).filter(Boolean);
            return okResult(negotiateA2aV10Version(peer));
          }
          case 'handshake': {
            const card = getRecordArg(args, 'card');
            const baseUrl = getStringArg(args, 'baseUrl');
            if (!isA2aV10LoopbackUrl(baseUrl)) throw new Error(`Base URL "${baseUrl}" is not loopback-only.`);
            const session = new A2aV10Session(async (_hs, message) => ({
              kind: 'message/text' as const,
              text: `echo: ${message.text}`,
              role: 'agent' as const,
              at: Date.now(),
            }));
            const hs = await session.handshakeWith(baseUrl, {
              localCapabilities: args.capabilities === undefined ? [] : getStringArrayArg(args, 'capabilities'),
              localAuthSchemes: (args.authSchemes === undefined ? ['none'] : getStringArrayArg(args, 'authSchemes')) as Array<'none' | 'bearer' | 'api-key' | 'mutual-tls'>,
              fetcher: async () => card,
            });
            return okResult({ version: hs.version, capabilities: hs.capabilities, authScheme: hs.authScheme, peer: hs.card.name });
          }
          case 'message': {
            const card = getRecordArg(args, 'card');
            const baseUrl = getStringArg(args, 'baseUrl');
            const text = getStringArg(args, 'text');
            const session = new A2aV10Session(async (_hs, message) => ({
              kind: 'message/text' as const,
              text: `echo: ${message.text}`,
              role: 'agent' as const,
              at: Date.now(),
            }));
            await session.handshakeWith(baseUrl, {
              localCapabilities: args.capabilities === undefined ? [] : getStringArrayArg(args, 'capabilities'),
              localAuthSchemes: (args.authSchemes === undefined ? ['none'] : getStringArrayArg(args, 'authSchemes')) as Array<'none' | 'bearer' | 'api-key' | 'mutual-tls'>,
              fetcher: async () => card,
            });
            return okResult({ reply: await session.send(text), history: session.messages() });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use validate-card | well-known | negotiate | handshake | message.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const deprecation: Tool = {
    definition: {
      name: 'protocol_v10_deprecation',
      description: 'Deprecation policy registry (12-month floor, 90-day security floor): list entries, register a deprecation, record a use, check whether removal is allowed, remove, list removable-now. LOCAL action.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | register | use | check-removal | remove | removable-now | pending | defaults | earliest-removal' },
          id: { type: 'string', description: 'Feature id for register / use / check-removal / remove.' },
          name: { type: 'string', description: 'Feature name for register.' },
          reason: { type: 'string', description: 'Deprecation reason (replaced | security | spec-removed | unused) for register.' },
          deprecatedSince: { type: 'string', description: 'YYYY-MM-DD deprecation date for register.' },
          replacedBy: { type: 'string', description: 'Replacement for register.' },
          securityFlaw: { type: 'boolean', description: 'True when an actively exploited security flaw forces the 90-day window.' },
          migrationNote: { type: 'string', description: 'Migration note for register.' },
          today: { type: 'string', description: 'YYYY-MM-DD date for check-removal / remove / removable-now / pending (default today).' },
          overrideReason: { type: 'string', description: 'Reason to override the removal guard for remove.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const registry = needDeprecations();
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'list':
            return okResult({ entries: registry.list() });
          case 'register': {
            const entry = registry.deprecate({
              id: getStringArg(args, 'id'),
              name: getStringArg(args, 'name'),
              reason: getStringArg(args, 'reason') as 'replaced' | 'security' | 'spec-removed' | 'unused',
              deprecatedSince: getStringArg(args, 'deprecatedSince'),
              replacedBy: getOptionalStringArg(args, 'replacedBy'),
              securityFlaw: getOptionalBooleanArg(args, 'securityFlaw'),
              migrationNote: getOptionalStringArg(args, 'migrationNote'),
            });
            return okResult(entry);
          }
          case 'use':
            return okResult({ useCount: registry.recordUse(getStringArg(args, 'id')) });
          case 'check-removal':
            return okResult({ problems: registry.checkRemoval(getStringArg(args, 'id'), getOptionalStringArg(args, 'today') ?? mcpV10TodayIso()) });
          case 'remove':
            return okResult(registry.remove(getStringArg(args, 'id'), getOptionalStringArg(args, 'today') ?? mcpV10TodayIso(), getOptionalStringArg(args, 'overrideReason')));
          case 'removable-now':
            return okResult({ entries: registry.removableNow(getOptionalStringArg(args, 'today') ?? mcpV10TodayIso()) });
          case 'pending':
            return okResult({ entries: registry.pending(getOptionalStringArg(args, 'today') ?? mcpV10TodayIso()) });
          case 'defaults':
            return okResult({ defaults: defaultMcpV10Deprecations() });
          case 'earliest-removal': {
            const since = getStringArg(args, 'deprecatedSince');
            const security = getOptionalBooleanArg(args, 'securityFlaw') === true;
            return okResult({ earliestRemoval: mcpV10EarliestRemovalDate(since, security), daysFromToday: mcpV10DaysBetween(mcpV10TodayIso(), mcpV10EarliestRemovalDate(since, security)) });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use list | register | use | check-removal | remove | removable-now | pending | defaults | earliest-removal.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const registryTool: Tool = {
    definition: {
      name: 'protocol_v10_registry',
      description: 'Unified protocols v10 registry: counts across the version matrix, stateless server, tool search, tasks, apps bridge and deprecation registry. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'counts' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (action !== 'counts') throw new Error('Unknown action "' + action + '". Use counts.');
        const server = needServer();
        const search = needSearch();
        const tasks = needTasks();
        const bridge = needBridge();
        const deprecations = needDeprecations();
        return okResult({
          versions: protocolV10MatrixSummary(),
          stateless: { totalCalls: server.totalCalls, subscriptions: server.subscriptions.countsByKind() },
          toolSearch: { total: search.total, deferred: search.deferredCount, loaded: search.loadedCount },
          tasks: tasks.store.counts(),
          apps: { sessions: bridge.list().length },
          deprecations: { total: deprecations.list().length, removableNow: deprecations.removableNow().length },
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    versions,
    stateless,
    oauth,
    toolSearch,
    script,
    tasks,
    apps,
    appsBridge,
    roundtrip,
    a2a,
    deprecation,
    registryTool,
  ];
}

export const PROTOCOL_V118_TOOLS: Tool[] = createProtocolV118Tools();

export const PROTOCOL_V118_TOOL_NAMES = [
  'protocol_v10_versions',
  'protocol_v10_stateless',
  'protocol_v10_oauth',
  'protocol_v10_tool_search',
  'protocol_v10_script',
  'protocol_v10_tasks',
  'protocol_v10_apps',
  'protocol_v10_apps_bridge',
  'protocol_v10_roundtrip',
  'protocol_v10_a2a',
  'protocol_v10_deprecation',
  'protocol_v10_registry',
] as const;

export type ProtocolV118ToolName = (typeof PROTOCOL_V118_TOOL_NAMES)[number];

export function isProtocolV118ToolName(name: string): name is ProtocolV118ToolName {
  return (PROTOCOL_V118_TOOL_NAMES as readonly string[]).includes(name);
}
