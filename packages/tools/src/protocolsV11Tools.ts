/**
 * Protocols v11 tools for @open-bot/tools (v1.42, Team T2).
 *
 * The agent drives the protocols-v11 stack by tool call:
 *  - protocol_v11_versions    — version matrix / changes since v10 / downgrade to v10 / negotiate / interop matrix / feature flags / summary (read)
 *  - protocol_v11_stateless   — MCP 2.0 stateless over a loopback server: discover / tools list+call / resources list / call counts (local action)
 *  - protocol_v11_discover    — discover + routing headers (build / parse / wire) (read)
 *  - protocol_v11_cache       — cacheable lists: list with known hash (not-modified), client cache get/put/invalidate/kinds (local action)
 *  - protocol_v11_roundtrip   — multi round-trip: validate request / validate answer / run confirm demo (2 rounds) / run two-step demo (3 rounds) (local action)
 *  - protocol_v11_tasks       — Tasks extension (io.modelcontextprotocol/tasks): create / get / list / progress / request-input / provide-input / complete / fail / cancel / poll / counts / snapshot / restore / sweep (local action)
 *  - protocol_v11_oauth       — mandatory iss validation: validate issuer URL / validate token / auth-server metadata / protected-resource metadata / token binding (read)
 *  - protocol_v11_interop     — handshake fallback: negotiate / matrix / detect / legacy demo (initialize + list + call on a 2025-11-25 simulator) / summary (local action)
 *  - protocol_v11_apps        — MCP Apps UI extension (io.modelcontextprotocol/ui): validate resource / build CSP / validate message / session open+initialize+call+notify+close+audit (local action)
 *  - protocol_v11_deprecation — deprecated roots/sampling/logging: list / earliest-removal / check-removal / removable-now (read)
 *  - protocol_v11_meta        — _meta build / validate + capability flag validation (read)
 *  - protocol_v11_registry    — unified registry: counts across versions, stateless server, tasks, apps sessions, deprecations; server registry (register/list/get/remove/resolve/health/snapshot/restore) + request audit log (list/counts/errors/stats) (local action)
 *
 * Factory:
 *   createProtocolV119Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V119_TOOLS                       (unbound placeholder)
 *
 * State: when the host does not bind its own stores, the factory
 * creates one shared in-memory set (stateless server, task engine,
 * list cache, app sessions, deprecation list) and shares it across
 * the 12 tools, so the tools work standalone. The host may override
 * any piece via ProtocolV119ToolOptions.
 *
 * SAFETY: the tools never carry credentials (tokens are opaque
 * values the host supplies for validation only; iss mismatch is
 * a hard reject), never write to disk by themselves (stores are
 * in-memory; the host mirrors snapshots), and never open a network
 * connection (the stateless client runs over an in-process loopback
 * server; the legacy demo runs against an in-process simulator).
 */
import type { Tool } from '@open-bot/core';
import {
  McpV11AppSession,
  McpV11LegacyClient,
  McpV11LegacyServerSimulator,
  McpV11ListCache,
  McpV11RoundTripLoop,
  McpV11ServerRegistry,
  McpV11StatelessClient,
  McpV11StatelessServer,
  McpV11TaskEngine,
  buildMcpV11AppCsp,
  buildMcpV11RequestMeta,
  buildMcpV11RoutingHeaders,
  checkMcpV11TokenBinding,
  createLoopbackMcpV11Sender,
  defaultMcpV11Deprecations,
  detectMcpV11ServerMode,
  hashMcpV11List,
  isMcpV11TaskTerminal,
  mcpV11DaysBetween,
  mcpV11EarliestRemovalDate,
  mcpV11InteropMatrix,
  mcpV11InteropMatrixTable,
  mcpV11InteropSummary,
  mcpV11LegacySummary,
  mcpV11NeedsHandshake,
  mcpV11TodayIso,
  mcpV11TokenBindingFingerprint,
  mcpV11VersionRank,
  negotiateMcpV11Interop,
  negotiateMcpV11Version,
  parseMcpV11RoutingHeaders,
  pollMcpV11Task,
  protocolV11ChangesSinceV10,
  protocolV11DowngradeToV10,
  validateMcpV11AppResource,
  validateMcpV11AuthServerMetadata,
  validateMcpV11InputAnswer,
  validateMcpV11InputRequest,
  validateMcpV11IssuerUrl,
  validateMcpV11ProtectedResourceMetadata,
  validateMcpV11RequestMeta,
  validateMcpV11TokenIssuer,
  validateMcpV11UiMessage,
  validateMcpV11Features,
  MCP_V11_CURRENT_VERSION,
  MCP_V11_DEPRECATION_EARLIEST_REMOVAL,
  MCP_V11_EXTENSIONS,
  MCP_V11_HANDSHAKE_CUTOFF_VERSION,
  MCP_V11_LEGACY_VERSIONS,
  MCP_V11_TASKS_EXTENSION,
  MCP_V11_UI_EXTENSION,
  MCP_V11_VERSIONS,
  mcpV11DemoConfirmHandler,
  mcpV11DemoTwoStepHandler,
  type McpV11AppResource,
  type McpV11TaskStatus,
  type McpV11Token,
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
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

function getOptionalRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  return getRecordArg(args, name);
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

function parseTokenArg(args: Record<string, unknown>): McpV11Token {
  const raw = getRecordArg(args, 'token');
  const value = getStringArg(raw, 'value');
  const issuer = getStringArg(raw, 'issuer');
  const audience = raw.audience;
  if (audience !== undefined && typeof audience !== 'string' && !Array.isArray(audience)) {
    throw new Error('token.audience must be a string or an array of strings.');
  }
  return {
    value,
    issuer,
    audience: audience as string | string[] | undefined,
    tokenId: getOptionalStringArg(raw, 'tokenId'),
    expiresAtSec: getOptionalNumberArg(raw, 'expiresAtSec'),
    issuedAtSec: getOptionalNumberArg(raw, 'issuedAtSec'),
    scope: getOptionalStringArg(raw, 'scope'),
  };
}

/** Options for the v11 tools (host bindings). */
export interface ProtocolV119ToolOptions {
  /** Stateless server accessor (the host binds its server). */
  getStatelessServer?: () => McpV11StatelessServer | null;
  /** Task engine accessor (the host binds its engine). */
  getTaskEngine?: () => McpV11TaskEngine | null;
  /** List cache accessor (the host binds its cache). */
  getListCache?: () => McpV11ListCache | null;
}

/** Built-in task handlers the tasks tool can run (local, no network). */
function v11TaskHandler(kind: string): (input: Record<string, unknown>, ctx: { progress: (p: number, m: string) => void }) => Record<string, unknown> | Promise<Record<string, unknown>> {
  switch (kind) {
    case 'sum': {
      return (input) => {
        const numbers = Array.isArray(input.numbers) ? (input.numbers as unknown[]) : [];
        const total = numbers.reduce<number>((acc, n) => acc + (typeof n === 'number' ? n : 0), 0);
        return { sum: total, count: numbers.length };
      };
    }
    case 'progress-demo': {
      return (_input, ctx) => {
        ctx.progress(25, 'started');
        ctx.progress(50, 'halfway');
        ctx.progress(75, 'almost done');
        return { done: true, steps: 3 };
      };
    }
    case 'slow': {
      // Stays running for ~300 ms so the caller can cancel it
      // while it runs (the other built-in handlers finish at once).
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { done: true, slow: true };
      };
    }
    case 'echo':
    default: {
      return (input) => ({ echoed: input });
    }
  }
}

export function createProtocolV119Tools(opts: ProtocolV119ToolOptions = {}): Tool[] {
  // Shared in-memory state, created once per factory call and shared
  // across the 12 tools (mirrors the v10 tools pattern).
  let sharedServer: McpV11StatelessServer | null = null;
  let sharedEngine: McpV11TaskEngine | null = null;
  let sharedCache: McpV11ListCache | null = null;
  let sharedRegistry: McpV11ServerRegistry | null = null;
  const appSessions = new Map<string, McpV11AppSession>();
  const deprecations = defaultMcpV11Deprecations();

  function needServer(): McpV11StatelessServer {
    const bound = opts.getStatelessServer?.();
    if (bound) return bound;
    if (!sharedServer) {
      sharedServer = new McpV11StatelessServer({
        tools: [
          { name: 'echo', description: 'Echo the arguments back.', handler: (args) => ({ echoed: args }) },
          {
            name: 'add',
            description: 'Add two numbers.',
            handler: (args) => ({
              sum: (typeof args.a === 'number' ? args.a : 0) + (typeof args.b === 'number' ? args.b : 0),
            }),
          },
          {
            name: 'demo-confirm',
            description: 'Demo tool that asks for confirmation (MRTR, 2 rounds).',
            handler: (args, round) => mcpV11DemoConfirmHandler(args, round) as unknown as Record<string, unknown>,
          },
        ],
        resources: [
          { name: 'config', description: 'Server configuration resource.' },
          { name: 'readme', description: 'Server readme resource.' },
        ],
        prompts: [{ name: 'greet', description: 'Greeting prompt.' }],
      });
    }
    return sharedServer;
  }

  function needEngine(): McpV11TaskEngine {
    const bound = opts.getTaskEngine?.();
    if (bound) return bound;
    if (!sharedEngine) sharedEngine = new McpV11TaskEngine();
    return sharedEngine;
  }

  function needCache(): McpV11ListCache {
    const bound = opts.getListCache?.();
    if (bound) return bound;
    if (!sharedCache) sharedCache = new McpV11ListCache();
    return sharedCache;
  }

  function needServerRegistry(): McpV11ServerRegistry {
    if (!sharedRegistry) sharedRegistry = new McpV11ServerRegistry();
    return sharedRegistry;
  }

  const versions: Tool = {
    definition: {
      name: 'protocol_v11_versions',
      description: 'MCP 2.0 (v11) version matrix: current/legacy versions, changes since v10, downgrade, negotiate, interop matrix, feature flags, summary. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'matrix | changes | downgrade | negotiate | interop | interop-table | flags | summary' },
          offered: { type: 'string', description: 'Comma-separated versions offered by the peer (negotiate).' },
          clientVersion: { type: 'string', description: 'Client version for the interop pair (interop).' },
          serverVersion: { type: 'string', description: 'Server version for the interop pair (interop).' },
          features: { type: 'object', description: 'Feature-flag object to validate (flags).' },
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
            return okResult({
              current: MCP_V11_CURRENT_VERSION,
              versions: [...MCP_V11_VERSIONS],
              legacy: [...MCP_V11_LEGACY_VERSIONS],
              handshakeCutoff: MCP_V11_HANDSHAKE_CUTOFF_VERSION,
              extensions: [...MCP_V11_EXTENSIONS],
              tasksExtension: MCP_V11_TASKS_EXTENSION,
              uiExtension: MCP_V11_UI_EXTENSION,
              deprecationEarliestRemoval: MCP_V11_DEPRECATION_EARLIEST_REMOVAL,
            });
          case 'changes':
            return okResult({ changes: protocolV11ChangesSinceV10() });
          case 'downgrade':
            return okResult({ downgrade: protocolV11DowngradeToV10() });
          case 'negotiate': {
            const offered = getStringArg(args, 'offered').split(',').map((s) => s.trim()).filter(Boolean);
            const agreed = negotiateMcpV11Version(offered);
            if (!agreed) throw new Error('No overlapping MCP version.');
            return okResult({ agreed, rank: mcpV11VersionRank(agreed) });
          }
          case 'interop': {
            const clientVersion = getOptionalStringArg(args, 'clientVersion') ?? MCP_V11_CURRENT_VERSION;
            const serverVersion = getStringArg(args, 'serverVersion');
            return okResult(negotiateMcpV11Interop(clientVersion, serverVersion));
          }
          case 'interop-table':
            return okResult({ rows: mcpV11InteropMatrixTable(), summary: mcpV11InteropSummary() });
          case 'flags': {
            const features = getRecordArg(args, 'features');
            return okResult({ problems: validateMcpV11Features(features) });
          }
          case 'summary':
            return okResult({ summary: `mcp ${MCP_V11_CURRENT_VERSION} (stateless); interop: ${mcpV11InteropSummary()}; ${mcpV11LegacySummary()}` });
          default:
            throw new Error('Unknown action "' + action + '". Use matrix | changes | downgrade | negotiate | interop | interop-table | flags | summary.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stateless: Tool = {
    definition: {
      name: 'protocol_v11_stateless',
      description: 'MCP 2.0 stateless core over the loopback server: discover, tools list/call, resources list, prompts list, call counts. Local action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'discover | list-tools | list-resources | list-prompts | call-tool | counts | refuse-check' },
          name: { type: 'string', description: 'Tool name (call-tool).' },
          arguments: { type: 'object', description: 'Tool arguments (call-tool).' },
          method: { type: 'string', description: 'Method to send raw (refuse-check): initialize | sampling/createMessage | roots/list.' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const server = needServer();
        const client = new McpV11StatelessClient(createLoopbackMcpV11Sender(server), {
          clientInfo: { name: 'open-bot', version: '1.42.0' },
        });
        switch (action) {
          case 'discover': {
            const result = await client.discover();
            return okResult({ ...result, tasksOffered: result.extensions.includes(MCP_V11_TASKS_EXTENSION), appsOffered: result.extensions.includes(MCP_V11_UI_EXTENSION) });
          }
          case 'list-tools': {
            await client.discover();
            return okResult(await client.listTools());
          }
          case 'list-resources': {
            await client.discover();
            return okResult(await client.listResources());
          }
          case 'list-prompts': {
            await client.discover();
            const response = await server.dispatch(
              { jsonrpc: '2.0', method: 'prompts/list', params: { _meta: buildMcpV11RequestMeta() }, id: 1 },
              {},
            );
            if (response.error) throw new Error(response.error.message);
            return okResult(response.result);
          }
          case 'call-tool': {
            await client.discover();
            const name = getStringArg(args, 'name');
            const callArgs = getOptionalRecordArg(args, 'arguments') ?? {};
            return okResult(await client.callTool(name, callArgs));
          }
          case 'counts':
            return okResult({ totalCalls: server.totalCalls, tools: server.toolNames() });
          case 'refuse-check': {
            const method = getStringArg(args, 'method');
            const response = await server.dispatch(
              { jsonrpc: '2.0', method, params: { _meta: buildMcpV11RequestMeta() }, id: 1 },
              {},
            );
            return okResult({ refused: Boolean(response.error), error: response.error ?? null });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use discover | list-tools | list-resources | list-prompts | call-tool | counts | refuse-check.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const discover: Tool = {
    definition: {
      name: 'protocol_v11_discover',
      description: 'server/discover plus MCP 2.0 routing headers: build headers, parse wire headers, discover the loopback server. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'discover | build-headers | parse-headers' },
          routingKey: { type: 'string', description: 'Routing key (build-headers).' },
          targetServer: { type: 'string', description: 'Target server id (build-headers).' },
          headers: { type: 'object', description: 'Wire headers to parse (parse-headers).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'discover': {
            const server = needServer();
            const client = new McpV11StatelessClient(createLoopbackMcpV11Sender(server));
            return okResult(await client.discover());
          }
          case 'build-headers': {
            const headers = buildMcpV11RoutingHeaders({
              routingKey: getOptionalStringArg(args, 'routingKey'),
              targetServer: getOptionalStringArg(args, 'targetServer'),
            });
            return okResult({ headers, wire: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v])) });
          }
          case 'parse-headers': {
            const raw = getRecordArg(args, 'headers');
            const wire: Record<string, string> = {};
            for (const [k, v] of Object.entries(raw)) {
              if (typeof v !== 'string') throw new Error(`Header "${k}" must be a string.`);
              wire[k] = v;
            }
            return okResult(parseMcpV11RoutingHeaders(wire));
          }
          default:
            throw new Error('Unknown action "' + action + '". Use discover | build-headers | parse-headers.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const cache: Tool = {
    definition: {
      name: 'protocol_v11_cache',
      description: 'Cacheable lists (MCP 2.0): list tools with a known hash (not-modified answer), hash a list, client cache get/put/invalidate/kinds. Local action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | hash | cache-get | cache-invalidate | cache-kinds' },
          knownListHash: { type: 'string', description: 'Hash the client already holds (list).' },
          entries: { type: 'array', description: 'List entries to hash (hash): [{name, description}].' },
          kind: { type: 'string', description: 'List kind (cache-get, cache-invalidate).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const server = needServer();
        switch (action) {
          case 'list': {
            const known = getOptionalStringArg(args, 'knownListHash');
            const response = await server.dispatch(
              {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: { _meta: buildMcpV11RequestMeta(), ...(known ? { knownListHash: known } : {}) },
                id: 1,
              },
              {},
            );
            if (response.error) throw new Error(response.error.message);
            return okResult(response.result);
          }
          case 'hash': {
            const raw = args.entries;
            if (!Array.isArray(raw)) throw new Error('Argument "entries" must be an array.');
            const entries = raw as Array<Record<string, unknown>>;
            return okResult({
              listHash: hashMcpV11List(entries.map((e) => ({ name: String(e.name ?? ''), description: typeof e.description === 'string' ? e.description : undefined }))),
            });
          }
          case 'cache-get': {
            const kind = getStringArg(args, 'kind');
            return okResult(needCache().get(kind));
          }
          case 'cache-invalidate': {
            const kind = getOptionalStringArg(args, 'kind');
            needCache().invalidate(kind);
            return okResult({ invalidated: kind ?? 'all', kinds: needCache().kinds() });
          }
          case 'cache-kinds':
            return okResult({ kinds: needCache().kinds() });
          default:
            throw new Error('Unknown action "' + action + '". Use list | hash | cache-get | cache-invalidate | cache-kinds.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const roundtrip: Tool = {
    definition: {
      name: 'protocol_v11_roundtrip',
      description: 'Multi round-trip requests (SEP-2322): validate an input request / answer, run the confirm demo (2 rounds) or the two-step demo (3 rounds) with scripted answers. Local action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-request | validate-answer | run-confirm | run-two-step' },
          request: { type: 'object', description: 'Input request to validate (validate-request, validate-answer).' },
          answer: { type: 'object', description: 'Answer to validate (validate-answer) or scripted answers (run-confirm, run-two-step).' },
          item: { type: 'string', description: 'Item name for the confirm demo (run-confirm).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'validate-request': {
            const request = getRecordArg(args, 'request');
            return okResult({ problems: validateMcpV11InputRequest(request) });
          }
          case 'validate-answer': {
            const request = getRecordArg(args, 'request') as unknown as Parameters<typeof validateMcpV11InputAnswer>[0];
            const answer = getRecordArg(args, 'answer');
            return okResult({ problems: validateMcpV11InputAnswer(request, answer) });
          }
          case 'run-confirm': {
            const scripted = getOptionalRecordArg(args, 'answer') ?? { confirmed: true, reason: 'cleanup' };
            const item = getOptionalStringArg(args, 'item') ?? 'demo-item';
            const loop = new McpV11RoundTripLoop();
            const outcome = await loop.run({
              args: { item },
              call: (callArgs, round) => mcpV11DemoConfirmHandler(callArgs, round),
              answerInput: async () => ({ ...scripted }),
            });
            return okResult(outcome);
          }
          case 'run-two-step': {
            const scripted = getOptionalRecordArg(args, 'answer') ?? {};
            const loop = new McpV11RoundTripLoop();
            const outcome = await loop.run({
              args: {},
              call: (callArgs, round) => mcpV11DemoTwoStepHandler(callArgs, round),
              answerInput: async (request) => {
                if (request.id === 'pick-mode') return { mode: (scripted.mode as string) ?? 'safe' };
                return { count: (scripted.count as number) ?? 3 };
              },
            });
            return okResult(outcome);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use validate-request | validate-answer | run-confirm | run-two-step.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tasks: Tool = {
    definition: {
      name: 'protocol_v11_tasks',
      description: 'Tasks extension (io.modelcontextprotocol/tasks): create / get / list / progress / request-input / provide-input / complete / fail / cancel / poll / counts / snapshot / restore / sweep. Local action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create | get | list | progress | request-input | provide-input | complete | fail | cancel | poll | counts | snapshot | restore | sweep' },
          id: { type: 'string', description: 'Task id.' },
          kind: { type: 'string', description: 'Task kind / handler: echo | sum | progress-demo | slow (create).' },
          input: { type: 'object', description: 'Task input (create) or provided input (provide-input).' },
          status: { type: 'string', description: 'Status filter (list): created | running | input_required | completed | failed | cancelled.' },
          percent: { type: 'number', description: 'Progress percent 0..100 (progress).' },
          message: { type: 'string', description: 'Progress message (progress) or error (fail).' },
          result: { type: 'object', description: 'Completion result (complete).' },
          pending: { type: 'object', description: 'Pending input descriptor {id, title, reason, fields} (request-input).' },
          snapshot: { type: 'object', description: 'Snapshot to restore {tasks: [...]} (restore).' },
          maxPolls: { type: 'number', description: 'Max polls (poll).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const engine = needEngine();
        switch (action) {
          case 'create': {
            const kind = getStringArg(args, 'kind');
            const input = getOptionalRecordArg(args, 'input') ?? {};
            const task = engine.create(kind, input, v11TaskHandler(kind));
            return okResult(task);
          }
          case 'get':
            return okResult(engine.get(getStringArg(args, 'id')));
          case 'list': {
            const status = getOptionalStringArg(args, 'status') as McpV11TaskStatus | undefined;
            if (status && !['created', 'running', 'input_required', 'completed', 'failed', 'cancelled'].includes(status)) {
              throw new Error(`Unknown status "${status}".`);
            }
            return okResult({ tasks: engine.list(status) });
          }
          case 'progress': {
            const id = getStringArg(args, 'id');
            const percent = getOptionalNumberArg(args, 'percent') ?? 0;
            const message = getOptionalStringArg(args, 'message') ?? '';
            return okResult(engine.store.progress(id, percent, message));
          }
          case 'request-input': {
            const id = getStringArg(args, 'id');
            const pending = getRecordArg(args, 'pending');
            const fields = pending.fields;
            if (!Array.isArray(fields) || fields.some((f) => typeof f !== 'string')) {
              throw new Error('pending.fields must be an array of strings.');
            }
            return okResult(engine.store.requestInput(id, {
              id: getStringArg(pending, 'id'),
              title: getStringArg(pending, 'title'),
              reason: getStringArg(pending, 'reason'),
              fields: fields as string[],
            }));
          }
          case 'provide-input':
            return okResult(engine.store.provideInput(getStringArg(args, 'id'), getOptionalRecordArg(args, 'input') ?? {}));
          case 'complete':
            return okResult(engine.store.complete(getStringArg(args, 'id'), getOptionalRecordArg(args, 'result') ?? {}));
          case 'fail':
            return okResult(engine.store.fail(getStringArg(args, 'id'), getOptionalStringArg(args, 'message') ?? 'failed'));
          case 'cancel':
            return okResult(engine.cancel(getStringArg(args, 'id')));
          case 'poll': {
            const id = getStringArg(args, 'id');
            const maxPolls = getOptionalNumberArg(args, 'maxPolls') ?? 120;
            return okResult(await pollMcpV11Task(engine, id, { intervalMs: 10, maxPolls }));
          }
          case 'counts':
            return okResult(engine.counts());
          case 'snapshot':
            return okResult(engine.store.snapshot());
          case 'restore': {
            const snapshot = getRecordArg(args, 'snapshot');
            const tasks = snapshot.tasks;
            if (!Array.isArray(tasks)) throw new Error('snapshot.tasks must be an array.');
            return okResult({ restored: engine.store.restore({ tasks: tasks as never }) });
          }
          case 'sweep':
            return okResult({ expired: engine.store.sweep() });
          default:
            throw new Error('Unknown action "' + action + '". Use create | get | list | progress | request-input | provide-input | complete | fail | cancel | poll | counts | snapshot | restore | sweep.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const oauth: Tool = {
    definition: {
      name: 'protocol_v11_oauth',
      description: 'Mandatory OAuth iss validation (MCP 2.0, RFC 9207): validate issuer URL / validate token against its expected issuer / validate auth-server metadata / validate protected-resource metadata / token binding. READ-ONLY (no token is stored or sent).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-issuer | validate-token | validate-auth-metadata | validate-resource-metadata | binding | check-binding' },
          issuer: { type: 'string', description: 'Issuer URL (validate-issuer) or expected issuer (validate-token, metadata actions).' },
          token: { type: 'object', description: 'Token {value, issuer, audience?, expiresAtSec?, issuedAtSec?} (validate-token, binding, check-binding).' },
          expectedAudience: { type: 'string', description: 'Expected audience (validate-token).' },
          metadata: { type: 'object', description: 'Metadata document (validate-auth-metadata, validate-resource-metadata).' },
          fingerprint: { type: 'string', description: 'Binding fingerprint to check (check-binding).' },
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
            const issuer = getStringArg(args, 'issuer');
            return okResult({ issuer, problems: validateMcpV11IssuerUrl(issuer) });
          }
          case 'validate-token': {
            const token = parseTokenArg(args);
            const expectedIssuer = getStringArg(args, 'issuer');
            const expectedAudience = getOptionalStringArg(args, 'expectedAudience');
            return okResult(validateMcpV11TokenIssuer(token, expectedIssuer, { expectedAudience }));
          }
          case 'validate-auth-metadata': {
            const metadata = getRecordArg(args, 'metadata');
            const expectedIssuer = getStringArg(args, 'issuer');
            return okResult({ problems: validateMcpV11AuthServerMetadata(metadata, expectedIssuer) });
          }
          case 'validate-resource-metadata': {
            const metadata = getRecordArg(args, 'metadata');
            const expectedIssuer = getStringArg(args, 'issuer');
            return okResult({ problems: validateMcpV11ProtectedResourceMetadata(metadata, expectedIssuer) });
          }
          case 'binding': {
            const token = parseTokenArg(args);
            return okResult({ fingerprint: mcpV11TokenBindingFingerprint(token.issuer, token.value) });
          }
          case 'check-binding': {
            const token = parseTokenArg(args);
            const fingerprint = getStringArg(args, 'fingerprint');
            return okResult({ matches: checkMcpV11TokenBinding(fingerprint, token.issuer, token.value) });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use validate-issuer | validate-token | validate-auth-metadata | validate-resource-metadata | binding | check-binding.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const interop: Tool = {
    definition: {
      name: 'protocol_v11_interop',
      description: 'Handshake fallback interop (MCP 2.0): negotiate a client/server pair, full interop matrix, detect a server mode, run the legacy demo against an in-process 2025-11-25 simulator, summary. Local action, no network.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'negotiate | matrix | detect | legacy-demo | summary' },
          clientVersion: { type: 'string', description: 'Client version (negotiate).' },
          serverVersion: { type: 'string', description: 'Server version (negotiate, legacy-demo).' },
          discoverOk: { type: 'boolean', description: 'Whether server/discover answered (detect).' },
          discoverErrorCode: { type: 'number', description: 'JSON-RPC error code when discover failed (detect).' },
          tool: { type: 'string', description: 'Tool to call in the legacy demo (legacy-demo): echo | add.' },
          arguments: { type: 'object', description: 'Tool arguments (legacy-demo).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'negotiate': {
            const clientVersion = getOptionalStringArg(args, 'clientVersion') ?? MCP_V11_CURRENT_VERSION;
            const serverVersion = getStringArg(args, 'serverVersion');
            return okResult(negotiateMcpV11Interop(clientVersion, serverVersion));
          }
          case 'matrix':
            return okResult({ rows: mcpV11InteropMatrix(), summary: mcpV11InteropSummary() });
          case 'detect': {
            const discoverOk = getOptionalBooleanArg(args, 'discoverOk') ?? false;
            const discoverErrorCode = getOptionalNumberArg(args, 'discoverErrorCode');
            const serverVersion = getOptionalStringArg(args, 'serverVersion');
            return okResult({ mode: detectMcpV11ServerMode({ discoverOk, protocolVersion: serverVersion, discoverErrorCode }) });
          }
          case 'legacy-demo': {
            const serverVersion = getOptionalStringArg(args, 'serverVersion') ?? '2025-11-25';
            if (!mcpV11NeedsHandshake(serverVersion)) {
              throw new Error(`Server ${serverVersion} speaks stateless MCP 2.0 — the handshake fallback does not apply.`);
            }
            const simulator = new McpV11LegacyServerSimulator(serverVersion);
            const warnings: string[] = [];
            const client = new McpV11LegacyClient(simulator.sender(), {
              onDeprecatedUse: (message) => warnings.push(message),
            });
            const handshake = await client.initialize(serverVersion);
            const tools = await client.listTools();
            const tool = getOptionalStringArg(args, 'tool') ?? 'echo';
            const callArgs = getOptionalRecordArg(args, 'arguments') ?? { hello: 'legacy' };
            const result = await client.callTool(tool, callArgs);
            return okResult({
              handshake,
              tools,
              result,
              sessionId: client.session,
              effectiveCapabilities: client.effectiveCapabilities,
              warnings,
            });
          }
          case 'summary':
            return okResult({ summary: mcpV11LegacySummary(), interop: mcpV11InteropSummary() });
          default:
            throw new Error('Unknown action "' + action + '". Use negotiate | matrix | detect | legacy-demo | summary.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const apps: Tool = {
    definition: {
      name: 'protocol_v11_apps',
      description: 'MCP Apps UI extension (io.modelcontextprotocol/ui): validate an app resource, build its CSP, validate a bridge message, run an app session (open/initialize/tool-call/notify/close/audit). Local action, no network, HTML is never executed.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'validate-resource | csp | validate-message | session-open | session-message | session-close | session-audit' },
          resource: { type: 'object', description: 'App resource {uri, mimeType, sandbox?, allowedDomains?, html?, title?} (validate-resource, csp, session-open).' },
          message: { type: 'object', description: 'Bridge message {jsonrpc, method, params?} (validate-message, session-message).' },
          sessionId: { type: 'string', description: 'App session id (session-message, session-close, session-audit).' },
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
            const resource = getRecordArg(args, 'resource');
            return okResult({ problems: validateMcpV11AppResource(resource) });
          }
          case 'csp': {
            const resource = getRecordArg(args, 'resource') as unknown as McpV11AppResource;
            return okResult({ csp: buildMcpV11AppCsp(resource) });
          }
          case 'validate-message': {
            const message = getRecordArg(args, 'message');
            return okResult({ problems: validateMcpV11UiMessage(message) });
          }
          case 'session-open': {
            const resource = getRecordArg(args, 'resource') as unknown as McpV11AppResource;
            const session = new McpV11AppSession(resource);
            appSessions.set(session.id, session);
            return okResult({ sessionId: session.id, status: session.status, csp: session.csp });
          }
          case 'session-message': {
            const sessionId = getStringArg(args, 'sessionId');
            const session = appSessions.get(sessionId);
            if (!session) throw new Error(`No app session "${sessionId}".`);
            const message = getRecordArg(args, 'message');
            return okResult(session.handle(message as never));
          }
          case 'session-close': {
            const sessionId = getStringArg(args, 'sessionId');
            const session = appSessions.get(sessionId);
            if (!session) throw new Error(`No app session "${sessionId}".`);
            session.close();
            return okResult({ sessionId, status: session.status });
          }
          case 'session-audit': {
            const sessionId = getStringArg(args, 'sessionId');
            const session = appSessions.get(sessionId);
            if (!session) throw new Error(`No app session "${sessionId}".`);
            return okResult({ sessionId, status: session.status, audit: session.audit, allowedCalls: session.allowedCalls });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use validate-resource | csp | validate-message | session-open | session-message | session-close | session-audit.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const deprecation: Tool = {
    definition: {
      name: 'protocol_v11_deprecation',
      description: 'Deprecated MCP features (roots / sampling / logging, deprecated 2026-07-28): list, earliest removal date, check whether one is removable now, list removable entries. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | earliest-removal | check-removal | removable-now' },
          id: { type: 'string', description: 'Feature id (check-removal): roots | sampling | logging.' },
          deprecatedSince: { type: 'string', description: 'ISO date the feature was deprecated (earliest-removal).' },
          securityFlaw: { type: 'boolean', description: 'Whether an actively exploited flaw is involved (earliest-removal).' },
          today: { type: 'string', description: 'ISO date to check against (check-removal, removable-now).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'list':
            return okResult({ entries: deprecations });
          case 'earliest-removal': {
            const since = getStringArg(args, 'deprecatedSince');
            const security = getOptionalBooleanArg(args, 'securityFlaw') === true;
            const earliest = mcpV11EarliestRemovalDate(since, security);
            return okResult({ earliestRemoval: earliest, daysFromToday: mcpV11DaysBetween(mcpV11TodayIso(), earliest) });
          }
          case 'check-removal': {
            const id = getStringArg(args, 'id');
            const entry = deprecations.find((d) => d.id === id);
            if (!entry) throw new Error(`Unknown deprecated feature "${id}".`);
            const today = getOptionalStringArg(args, 'today') ?? mcpV11TodayIso();
            const removable = mcpV11DaysBetween(today, entry.earliestRemoval) <= 0;
            return okResult({
              entry,
              today,
              removable,
              problems: removable ? [] : [`"${id}" may not be removed before ${entry.earliestRemoval} (12-month deprecation floor).`],
            });
          }
          case 'removable-now': {
            const today = getOptionalStringArg(args, 'today') ?? mcpV11TodayIso();
            return okResult({
              today,
              entries: deprecations.filter((d) => mcpV11DaysBetween(today, d.earliestRemoval) <= 0),
            });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use list | earliest-removal | check-removal | removable-now.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const meta: Tool = {
    definition: {
      name: 'protocol_v11_meta',
      description: 'MCP 2.0 _meta: build a request meta (protocol version + capabilities) and validate one, validate capability flags. READ-ONLY.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'build | validate | validate-features' },
          meta: { type: 'object', description: '_meta value to validate (validate).' },
          capabilities: { type: 'object', description: 'Capabilities to advertise (build) or flags to validate (validate-features).' },
          clientName: { type: 'string', description: 'Client name for clientInfo (build).' },
          clientVersion: { type: 'string', description: 'Client version for clientInfo (build).' },
          traceId: { type: 'string', description: '32-hex trace id (build).' },
          routingKey: { type: 'string', description: 'Routing key (build).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'build': {
            const capabilities = getOptionalRecordArg(args, 'capabilities') as
              | { multiRoundTrip?: boolean; tasks?: boolean; apps?: boolean; cacheableLists?: boolean; routing?: boolean }
              | undefined;
            const clientName = getOptionalStringArg(args, 'clientName');
            const clientVersion = getOptionalStringArg(args, 'clientVersion');
            return okResult({
              meta: buildMcpV11RequestMeta(capabilities ?? {}, {
                ...(clientName && clientVersion ? { clientInfo: { name: clientName, version: clientVersion } } : {}),
                ...(getOptionalStringArg(args, 'traceId') ? { traceId: getOptionalStringArg(args, 'traceId') as string } : {}),
                ...(getOptionalStringArg(args, 'routingKey') ? { routingKey: getOptionalStringArg(args, 'routingKey') as string } : {}),
              }),
            });
          }
          case 'validate': {
            const metaValue = getRecordArg(args, 'meta');
            return okResult({ problems: validateMcpV11RequestMeta(metaValue) });
          }
          case 'validate-features': {
            const features = getRecordArg(args, 'capabilities');
            return okResult({ problems: validateMcpV11Features(features) });
          }
          default:
            throw new Error('Unknown action "' + action + '". Use build | validate | validate-features.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const registryTool: Tool = {
    definition: {
      name: 'protocol_v11_registry',
      description: 'Unified protocols v11 registry: counts across the version matrix, stateless server, tasks, app sessions and deprecations; server registry (register/list/get/remove/resolve/health) and request audit log (list/counts/errors/stats). READ-ONLY except registry/audit queries (register/remove mutate only the in-memory registry).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'counts | servers-register | servers-list | servers-get | servers-remove | servers-resolve | servers-health | servers-counts | servers-snapshot | servers-restore | audit-list | audit-counts | audit-errors | audit-stats' },
          discover: { type: 'object', description: 'Discover document to register (servers-register).' },
          endpoint: { type: 'string', description: 'Endpoint for the registered server (servers-register).' },
          id: { type: 'string', description: 'Server id (servers-get, servers-remove, servers-health).' },
          routingKey: { type: 'string', description: 'Routing key to resolve (servers-resolve).' },
          health: { type: 'string', description: 'Health to set: ok | degraded | down (servers-health).' },
          reason: { type: 'string', description: 'Health reason (servers-health).' },
          snapshot: { type: 'object', description: 'Snapshot to restore {servers: [...]} (servers-restore).' },
          method: { type: 'string', description: 'Method filter (audit-list).' },
        },
        required: ['action'],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const server = needServer();
        const engine = needEngine();
        const registry = needServerRegistry();
        switch (action) {
          case 'counts': {
            return okResult({
              current: MCP_V11_CURRENT_VERSION,
              interop: mcpV11InteropSummary(),
              stateless: { totalCalls: server.totalCalls, tools: server.toolNames() },
              tasks: engine.counts(),
              apps: { sessions: appSessions.size },
              deprecations: { total: deprecations.length, entries: deprecations.map((d) => d.id) },
              servers: registry.counts(),
              audit: server.audit.counts(),
              isTaskTerminalExample: isMcpV11TaskTerminal('completed'),
            });
          }
          case 'servers-register': {
            const discover = getRecordArg(args, 'discover');
            const endpoint = getStringArg(args, 'endpoint');
            const id = getOptionalStringArg(args, 'id');
            return okResult(registry.register(discover as never, endpoint, id));
          }
          case 'servers-list':
            return okResult({ servers: registry.list() });
          case 'servers-get':
            return okResult(registry.require(getStringArg(args, 'id')));
          case 'servers-remove':
            return okResult({ removed: registry.remove(getStringArg(args, 'id')) });
          case 'servers-resolve':
            return okResult(registry.resolveRoutingKey(getStringArg(args, 'routingKey')));
          case 'servers-health': {
            const id = getStringArg(args, 'id');
            const health = getStringArg(args, 'health');
            if (!['ok', 'degraded', 'down'].includes(health)) throw new Error(`Unknown health "${health}".`);
            return okResult(registry.setHealth(id, health as 'ok' | 'degraded' | 'down', getOptionalStringArg(args, 'reason')));
          }
          case 'servers-counts':
            return okResult(registry.counts());
          case 'servers-snapshot':
            return okResult(registry.snapshot());
          case 'servers-restore': {
            const snapshot = getRecordArg(args, 'snapshot');
            const servers = snapshot.servers;
            if (!Array.isArray(servers)) throw new Error('snapshot.servers must be an array.');
            return okResult({ restored: registry.restore({ servers: servers as never }) });
          }
          case 'audit-list': {
            const method = getOptionalStringArg(args, 'method');
            return okResult({ entries: method ? server.audit.byMethod(method) : server.audit.list() });
          }
          case 'audit-counts':
            return okResult(server.audit.counts());
          case 'audit-errors':
            return okResult({ entries: server.audit.errors() });
          case 'audit-stats':
            return okResult({ methods: server.audit.methodStats() });
          default:
            throw new Error('Unknown action "' + action + '". Use counts | servers-register | servers-list | servers-get | servers-remove | servers-resolve | servers-health | servers-counts | servers-snapshot | servers-restore | audit-list | audit-counts | audit-errors | audit-stats.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    versions,
    stateless,
    discover,
    cache,
    roundtrip,
    tasks,
    oauth,
    interop,
    apps,
    deprecation,
    meta,
    registryTool,
  ];
}

export const PROTOCOL_V119_TOOLS: Tool[] = createProtocolV119Tools();

export const PROTOCOL_V119_TOOL_NAMES = [
  'protocol_v11_versions',
  'protocol_v11_stateless',
  'protocol_v11_discover',
  'protocol_v11_cache',
  'protocol_v11_roundtrip',
  'protocol_v11_tasks',
  'protocol_v11_oauth',
  'protocol_v11_interop',
  'protocol_v11_apps',
  'protocol_v11_deprecation',
  'protocol_v11_meta',
  'protocol_v11_registry',
] as const;

export type ProtocolV119ToolName = (typeof PROTOCOL_V119_TOOL_NAMES)[number];

export function isProtocolV119ToolName(name: string): name is ProtocolV119ToolName {
  return (PROTOCOL_V119_TOOL_NAMES as readonly string[]).includes(name);
}
