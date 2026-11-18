/**
 * Protocols v5 tools for @open-bot/tools (v1.29, Team T2).
 *
 * The agent drives the protocols-v5 stack by tool call:
 *  - protocol_v5_negotiate          — negotiate protocol versions per family, or all families at once (read)
 *  - protocol_v5_bg_task_start      — start a background MCP task: returns a placeholder tool_result immediately (read-ish; starts work)
 *  - protocol_v5_bg_task_get        — read one background MCP task (read)
 *  - protocol_v5_bg_task_list       — list background MCP tasks, optionally by status (read)
 *  - protocol_v5_bg_task_cancel     — cancel a running background MCP task (local action)
 *  - protocol_v5_permission_evaluate — evaluate one MCP tool call against its server's per-tool permission_policy (read)
 *  - protocol_v5_permission_set     — set one per-tool rule or the server default (local action, needs approval)
 *  - protocol_v5_permission_ask_resolve — resolve a pending `ask` decision (local action, needs approval)
 *  - protocol_v5_oauth_state        — auth state of one MCP server, or all servers needing auth (read)
 *  - protocol_v5_oauth_reconnect    — reconnect one MCP server after auth (needs a bound token provider; local action)
 *  - protocol_v5_acp_discover       — discover ACP agents by capability / name / ACP version (read)
 *  - protocol_v5_acp_session        — ACP v2 session ops: new / prompt / cancel / complete / get / list (local action)
 *
 * Factory:
 *   createProtocolV5Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V5_TOOLS                       (unbound placeholder)
 *
 * SAFETY: the tools never carry credentials (the OAuth reconnect
 * tool calls a token provider the host binds — it never reads the
 * Vault itself, and tokens never appear in tool output), never
 * execute a real MCP call by themselves (the background-task
 * runner is bound by the host; without one the tool runs a local
 * echo simulation and says so), and never grant a permission by
 * themselves (permission_set / ask_resolve need approval).
 *
 * NOTE (v1.29): exported from the tools package but NOT yet wired
 * into defaultToolFactory — the coordinator wires
 * createProtocolV5Tools and recounts the tool pin, as with the
 * v1.15/v1.16/v1.19 protocol tools.
 */
import type { Tool } from '@open-bot/core';
import {
  AcpAgentRegistry,
  AcpV2ClientAdapter,
  BackgroundMcpTaskManager,
  McpAuthSessionManager,
  McpPermissionPolicyRegistry,
  acpSessionToA2aTaskV5,
  negotiateAllProtocolsV5,
  negotiateProtocolV5Version,
  protocolV5DeprecationCalendar,
  type AcpAgentCard,
  type McpFreshToken,
  type ProtocolV5Family,
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

function getNumberArg(args: Record<string, unknown>, name: string, required = true): number {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, defaultValue = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
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

/** How a background MCP task's work is actually run (bound by the host). */
export type ProtocolV5BgTaskRunner = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** How a fresh OAuth token is obtained for a server (bound by the host). */
export type ProtocolV5TokenProvider = (serverName: string) => Promise<McpFreshToken>;

export interface ProtocolV5ToolOptions {
  /** Background-task manager accessor (host binds its manager). */
  getBgTaskManager?: () => BackgroundMcpTaskManager | null;
  /** Runner for real background MCP calls (host binds its MCP transport). */
  bgTaskRunner?: ProtocolV5BgTaskRunner;
  /** Permission-policy registry accessor (host binds its registry). */
  getPermissionRegistry?: () => McpPermissionPolicyRegistry | null;
  /** Auth-session manager accessor (host binds its manager). */
  getAuthSessionManager?: () => McpAuthSessionManager | null;
  /** Token provider for OAuth reconnect (host binds its provider). */
  tokenProvider?: ProtocolV5TokenProvider;
  /** ACP agent registry accessor (host binds its registry). */
  getAcpRegistry?: () => AcpAgentRegistry | null;
  /** ACP client adapter accessor (host binds its adapter). */
  getAcpClient?: () => AcpV2ClientAdapter | null;
}

export const PROTOCOL_V5_TOOL_NAMES = [
  'protocol_v5_negotiate',
  'protocol_v5_bg_task_start',
  'protocol_v5_bg_task_get',
  'protocol_v5_bg_task_list',
  'protocol_v5_bg_task_cancel',
  'protocol_v5_permission_evaluate',
  'protocol_v5_permission_set',
  'protocol_v5_permission_ask_resolve',
  'protocol_v5_oauth_state',
  'protocol_v5_oauth_reconnect',
  'protocol_v5_acp_discover',
  'protocol_v5_acp_session',
] as const;

export type ProtocolV5ToolName = (typeof PROTOCOL_V5_TOOL_NAMES)[number];

export function isProtocolV5ToolName(name: string): name is ProtocolV5ToolName {
  return (PROTOCOL_V5_TOOL_NAMES as readonly string[]).includes(name);
}

/** Unbound placeholder definitions (registry shape only). */
export const PROTOCOL_V5_TOOLS: Tool[] = PROTOCOL_V5_TOOL_NAMES.map((name) => ({
  definition: toolDef(name, `Protocols v5 tool ${name}.`, {}, []),
  needsApproval: false,
  async execute() {
    return errorResult(`Tool ${name} is not bound. Use createProtocolV5Tools() to bind it.`);
  },
}));

const PROTOCOL_V5_FAMILY_LIST: readonly string[] = ['acp', 'poppy', 'mcp', 'a2a', 'agui', 'a2ui'];
const MCP_BG_TASK_STATUSES: readonly string[] = ['pending', 'running', 'done', 'failed', 'cancelled'];
const PERMISSION_DECISIONS: readonly string[] = ['allow', 'deny', 'ask'];
const ASK_RESOLUTIONS: readonly string[] = ['allow-once', 'allow-always', 'deny-once', 'deny-always'];
const ACP_SESSION_ACTIONS: readonly string[] = ['new', 'prompt', 'cancel', 'complete', 'get', 'list'];

export function createProtocolV5Tools(opts: ProtocolV5ToolOptions = {}): Tool[] {
  let fallbackBgTasks: BackgroundMcpTaskManager | null = null;
  let fallbackPermissions: McpPermissionPolicyRegistry | null = null;
  let fallbackAuth: McpAuthSessionManager | null = null;
  let fallbackRegistry: AcpAgentRegistry | null = null;
  let fallbackAcpClient: AcpV2ClientAdapter | null = null;

  const needBgTasks = (): BackgroundMcpTaskManager =>
    opts.getBgTaskManager?.() ?? (fallbackBgTasks ??= new BackgroundMcpTaskManager());
  const needPermissions = (): McpPermissionPolicyRegistry =>
    opts.getPermissionRegistry?.() ?? (fallbackPermissions ??= new McpPermissionPolicyRegistry());
  const needAuth = (): McpAuthSessionManager =>
    opts.getAuthSessionManager?.() ?? (fallbackAuth ??= new McpAuthSessionManager());
  const needRegistry = (): AcpAgentRegistry =>
    opts.getAcpRegistry?.() ?? (fallbackRegistry ??= new AcpAgentRegistry());
  const needAcpClient = (): AcpV2ClientAdapter =>
    opts.getAcpClient?.() ??
    (fallbackAcpClient ??= new AcpV2ClientAdapter({
      runner: async (_sessionId, prompt) => ({ text: `Echo (no agent bound): ${prompt}` }),
    }));

  const negotiate: Tool = {
    definition: toolDef(
      'protocol_v5_negotiate',
      'Negotiate protocol v5 versions (read): one family (acp, poppy, mcp, a2a, agui, a2ui) when family is given, or all six families at once. Returns the agreed version per family, its lifecycle status (current / legacy / removed / unknown), whether it is a draft/RC, and the deprecation calendar.',
      {
        family: { type: 'string', description: 'Protocol family: acp, poppy, mcp, a2a, agui or a2ui. Omit to negotiate all families.' },
        serverVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the peer supports (single-family mode).' },
        serverVersionsByFamily: { type: 'object', description: 'All-families mode: { acp: [...], poppy: [...], mcp: [...], a2a: [...], agui: [...], a2ui: [...] }.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const family = args['family'] === undefined ? undefined : getStringArg(args, 'family');
        if (family !== undefined) {
          if (!PROTOCOL_V5_FAMILY_LIST.includes(family)) {
            throw new Error(`Unknown protocol family "${family}". Use acp, poppy, mcp, a2a, agui or a2ui.`);
          }
          const result = negotiateProtocolV5Version(
            family as ProtocolV5Family,
            getStringArrayArg(args, 'serverVersions'),
          );
          return JSON.stringify({ negotiation: result }, null, 2);
        }
        const byFamily = args['serverVersionsByFamily'] === undefined
          ? {}
          : getRecordArg(args, 'serverVersionsByFamily');
        const serverVersions: Partial<Record<ProtocolV5Family, readonly string[]>> = {};
        for (const f of PROTOCOL_V5_FAMILY_LIST) {
          const v = byFamily[f];
          if (v !== undefined) {
            if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
              throw new Error(`serverVersionsByFamily.${f} must be an array of strings.`);
            }
            serverVersions[f as ProtocolV5Family] = [...(v as string[])];
          }
        }
        return JSON.stringify(
          {
            negotiations: negotiateAllProtocolsV5(serverVersions),
            deprecationCalendar: protocolV5DeprecationCalendar(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bgTaskStart: Tool = {
    definition: toolDef(
      'protocol_v5_bg_task_start',
      'Start a background MCP task (SDK-style): returns a placeholder tool_result with the task id immediately instead of holding the call open; the real result arrives later as a task_notification. Without a host-bound runner this runs a local echo simulation and says so.',
      {
        serverName: { type: 'string', description: 'MCP server name.' },
        toolName: { type: 'string', description: 'MCP tool name to call in the background.' },
        args: { type: 'object', description: 'Arguments for the tool call.' },
        timeoutMs: { type: 'number', description: 'Timeout for the whole task in ms (default 600000).' },
        simulateDelayMs: { type: 'number', description: 'Simulation only: delay before the echo result (default 50). Ignored when a real runner is bound.' },
      },
      ['serverName', 'toolName'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const serverName = getStringArg(args, 'serverName');
        const toolName = getStringArg(args, 'toolName');
        const callArgs = getRecordArg(args, 'args');
        const timeoutMs = args['timeoutMs'] === undefined ? undefined : getNumberArg(args, 'timeoutMs');
        const simulateDelayMs = args['simulateDelayMs'] === undefined ? 50 : getNumberArg(args, 'simulateDelayMs');
        const manager = needBgTasks();
        const runner = opts.bgTaskRunner;
        const placeholder = manager.submit({
          serverName,
          toolName,
          args: callArgs,
          timeoutMs,
          run: async (signal) => {
            if (runner) return runner(serverName, toolName, callArgs, signal);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, Math.max(0, simulateDelayMs));
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Background task cancelled.'));
              });
            });
            if (signal.aborted) throw new Error('Background task cancelled.');
            return { simulated: true, serverName, toolName, args: callArgs, note: 'Local echo simulation — no real MCP server was called.' };
          },
        });
        return JSON.stringify({ placeholder, note: runner ? 'Real runner bound.' : 'Simulation: no real MCP runner is bound; the task echoes its arguments.' }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bgTaskGet: Tool = {
    definition: toolDef(
      'protocol_v5_bg_task_get',
      'Read one background MCP task by id (read): status (pending/running/done/failed/cancelled), result when done, error when failed, and whether it needs input.',
      { taskId: { type: 'string', description: 'Background task id from protocol_v5_bg_task_start.' } },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const task = needBgTasks().require(getStringArg(args, 'taskId'));
        return JSON.stringify({ task }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bgTaskList: Tool = {
    definition: toolDef(
      'protocol_v5_bg_task_list',
      'List background MCP tasks, newest first (read). Pass status to filter: pending, running, done, failed or cancelled.',
      { status: { type: 'string', description: 'Optional status filter.' } },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const status = args['status'] === undefined ? undefined : getStringArg(args, 'status');
        if (status !== undefined && !MCP_BG_TASK_STATUSES.includes(status)) {
          throw new Error(`Unknown task status "${status}". Use ${MCP_BG_TASK_STATUSES.join(', ')}.`);
        }
        const tasks = needBgTasks().list(status as never);
        return JSON.stringify({ tasks, count: tasks.length }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bgTaskCancel: Tool = {
    definition: toolDef(
      'protocol_v5_bg_task_cancel',
      'Cancel a running background MCP task (local action). Returns false when the task was already terminal or unknown.',
      {
        taskId: { type: 'string', description: 'Background task id.' },
        reason: { type: 'string', description: 'Why the task is cancelled.' },
      },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const cancelled = needBgTasks().cancel(
          getStringArg(args, 'taskId'),
          args['reason'] === undefined ? undefined : getStringArg(args, 'reason'),
        );
        return JSON.stringify({ cancelled }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const permissionEvaluate: Tool = {
    definition: toolDef(
      'protocol_v5_permission_evaluate',
      'Evaluate one MCP tool call against its server per-tool permission_policy (read): allow, deny or ask, with the rule that decided it and the reason. Call this before any MCP tool call.',
      {
        serverName: { type: 'string', description: 'MCP server name.' },
        toolName: { type: 'string', description: 'MCP tool name.' },
      },
      ['serverName', 'toolName'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const evaluation = needPermissions().evaluate(getStringArg(args, 'serverName'), getStringArg(args, 'toolName'));
        return JSON.stringify({ evaluation }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const permissionSet: Tool = {
    definition: toolDef(
      'protocol_v5_permission_set',
      'Set one per-tool permission rule, or the server default (local action, needs approval). Pattern may be an exact tool name, "*" for all tools, or one wildcard such as "server:*" or "*:read".',
      {
        serverName: { type: 'string', description: 'MCP server name.' },
        pattern: { type: 'string', description: 'Tool name or pattern. Omit to set only the server default.' },
        decision: { type: 'string', description: 'allow, deny or ask.' },
        note: { type: 'string', description: 'Why this rule exists (shown in the UI).' },
        setDefault: { type: 'boolean', description: 'When true, set the server default decision instead of a rule.' },
      },
      ['serverName', 'decision'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const serverName = getStringArg(args, 'serverName');
        const decision = getStringArg(args, 'decision');
        if (!PERMISSION_DECISIONS.includes(decision)) {
          throw new Error(`Unknown permission decision "${decision}". Use allow, deny or ask.`);
        }
        const policy = needPermissions().policyFor(serverName);
        if (getBooleanArg(args, 'setDefault', false)) {
          policy.setDefault(decision as never);
          return JSON.stringify({ serverName, defaultDecision: decision }, null, 2);
        }
        const pattern = getStringArg(args, 'pattern');
        const rule = policy.setRule(
          pattern,
          decision as never,
          args['note'] === undefined ? undefined : getStringArg(args, 'note'),
        );
        return JSON.stringify({ serverName, rule }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const permissionAskResolve: Tool = {
    definition: toolDef(
      'protocol_v5_permission_ask_resolve',
      'Resolve a pending permission ask (local action, needs approval): allow-once, allow-always (writes the rule back), deny-once or deny-always.',
      {
        serverName: { type: 'string', description: 'MCP server name.' },
        askId: { type: 'string', description: 'Pending ask id from protocol_v5_permission_evaluate.' },
        resolution: { type: 'string', description: 'allow-once, allow-always, deny-once or deny-always.' },
      },
      ['serverName', 'askId', 'resolution'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const resolution = getStringArg(args, 'resolution');
        if (!ASK_RESOLUTIONS.includes(resolution)) {
          throw new Error(`Unknown resolution "${resolution}". Use ${ASK_RESOLUTIONS.join(', ')}.`);
        }
        const resolved = needPermissions()
          .policyFor(getStringArg(args, 'serverName'))
          .resolveAsk(getStringArg(args, 'askId'), resolution as never);
        return JSON.stringify({ resolved }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const oauthState: Tool = {
    definition: toolDef(
      'protocol_v5_oauth_state',
      'Auth state of one MCP server, or all servers needing auth (read): connected, needs-auth, authenticating, reconnecting, disconnected or failed — plus queued calls and the auth challenge URL when one exists. Tokens are never shown.',
      { serverName: { type: 'string', description: 'MCP server name. Omit to list all servers needing auth.' } },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needAuth();
        if (args['serverName'] === undefined) {
          return JSON.stringify(
            { serversNeedingAuth: manager.serversNeedingAuth(), summaries: manager.summaries() },
            null,
            2,
          );
        }
        const session = manager.get(getStringArg(args, 'serverName'));
        if (!session) {
          return JSON.stringify({ serverName: getStringArg(args, 'serverName'), state: 'unknown', note: 'No session is tracked for this server yet.' }, null, 2);
        }
        return JSON.stringify({ session: session.toJSON(), challenge: session.getChallenge() }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const oauthReconnect: Tool = {
    definition: toolDef(
      'protocol_v5_oauth_reconnect',
      'Reconnect one MCP server after authentication (local action): obtains a fresh token from the host-bound token provider, restores connected, and returns the queued calls to replay. Fails clearly when no token provider is bound.',
      { serverName: { type: 'string', description: 'MCP server name.' } },
      ['serverName'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const serverName = getStringArg(args, 'serverName');
        if (!opts.tokenProvider) {
          throw new Error(`No token provider is bound for "${serverName}". Bind one via ProtocolV5ToolOptions.tokenProvider first.`);
        }
        const session = needAuth().sessionFor(serverName);
        const replay = await session.reconnect(() => (opts.tokenProvider as ProtocolV5TokenProvider)(serverName));
        return JSON.stringify({ serverName, state: session.getState(), replay }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const acpDiscover: Tool = {
    definition: toolDef(
      'protocol_v5_acp_discover',
      'Discover ACP agents in the registry (read): by capability, by name/description search, or by ACP version. Returns live agents only.',
      {
        capability: { type: 'string', description: 'Capability to look for, e.g. coding.' },
        query: { type: 'string', description: 'Name/description substring search.' },
        acpVersion: { type: 'string', description: 'ACP version the agent must speak, e.g. 2.0-draft.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const registry = needRegistry();
        let agents: AcpAgentCard[];
        if (args['capability'] !== undefined) {
          agents = registry.discoverByCapability(getStringArg(args, 'capability'));
        } else if (args['acpVersion'] !== undefined) {
          agents = registry.discoverByAcpVersion(getStringArg(args, 'acpVersion'));
        } else if (args['query'] !== undefined) {
          agents = registry.search(getStringArg(args, 'query'));
        } else {
          agents = registry.list();
        }
        return JSON.stringify({ agents, count: agents.length }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const acpSession: Tool = {
    definition: toolDef(
      'protocol_v5_acp_session',
      'ACP v2 session operations (local action): new (start a session with an agent), prompt (one turn), cancel, complete, get (with its A2A task view), list.',
      {
        action: { type: 'string', description: 'new, prompt, cancel, complete, get or list.' },
        agentId: { type: 'string', description: 'Agent id (new).' },
        sessionId: { type: 'string', description: 'Session id (prompt/cancel/complete/get).' },
        text: { type: 'string', description: 'Prompt text (prompt).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ACP_SESSION_ACTIONS.includes(action)) {
          throw new Error(`Unknown ACP session action "${action}". Use ${ACP_SESSION_ACTIONS.join(', ')}.`);
        }
        const client = needAcpClient();
        if (action === 'new') {
          const sessionId = client.newSession(getStringArg(args, 'agentId'));
          return JSON.stringify({ sessionId, session: client.getSession(sessionId) }, null, 2);
        }
        if (action === 'list') {
          return JSON.stringify({ sessions: client.listSessions() }, null, 2);
        }
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'prompt') {
          const answer = await client.prompt(sessionId, getStringArg(args, 'text'));
          return JSON.stringify({ sessionId, answer }, null, 2);
        }
        if (action === 'cancel') {
          return JSON.stringify({ sessionId, cancelled: client.cancel(sessionId) }, null, 2);
        }
        if (action === 'complete') {
          client.complete(sessionId);
          return JSON.stringify({ sessionId, status: client.getSession(sessionId)?.status }, null, 2);
        }
        const session = client.getSession(sessionId);
        if (!session) throw new Error(`Unknown ACP session "${sessionId}".`);
        return JSON.stringify({ session, a2aTask: acpSessionToA2aTaskV5(session) }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    negotiate,
    bgTaskStart,
    bgTaskGet,
    bgTaskList,
    bgTaskCancel,
    permissionEvaluate,
    permissionSet,
    permissionAskResolve,
    oauthState,
    oauthReconnect,
    acpDiscover,
    acpSession,
  ];
}
