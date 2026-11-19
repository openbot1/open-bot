/**
 * Protocols v9 tools for @open-bot/tools (v1.40, Team T2).
 *
 * The agent drives the protocols-v9 stack by tool call:
 *  - protocol_v9_versions       — version matrix / changes since v8 / downgrade to v8 / negotiate / feature flags (read)
 *  - protocol_v9_apps           — MCP Apps: register ui:// resource / render / validate HTML / CSP / call-back check (local action)
 *  - protocol_v9_apps_lifecycle — MCP Apps v2: open / close / reopen / suspend / resume / focus / move-slot / list / counts / events / callback / snapshot / restore / prune (local action)
 *  - protocol_v9_acp_detect     — detect the CLI agents on the machine (Claude Code / Codex / Gemini CLI) + login-marker presence (read; markers are only checked for existence, never read)
 *  - protocol_v9_acp_sessions   — ACP sessions: create / list / get / suspend / resume-suspended / resume / cancel / complete / set-mode / counts / events / snapshot / restore / prune (local action)
 *  - protocol_v9_acp_prompt     — send a prompt to an ACP session / read its history (local action; replies come from the injected runner, echo by default)
 *  - protocol_v9_a2a_cards      — Agent Cards: build / validate / register / discover (skill / tag / capability / search) / list / get / unregister / well-known URL (local action)
 *  - protocol_v9_a2a_tasks      — A2A tasks: create / get / list / transition / cancel / complete / request-input / provide-input / counts / events / sweep / prune / snapshot / restore (local action)
 *  - protocol_v9_a2a_messages   — A2A message + artifact exchange: send-message / history / add-artifact / list-artifacts (local action)
 *  - protocol_v9_a2a_delegate   — delegate a task with capability matching / match agents / loopback policy / push configs (local action, loopback-only)
 *  - protocol_v9_registry       — unified registry: counts + list across apps, ACP sessions, cards and tasks (read)
 *  - protocol_v9_snapshots      — durable snapshots: save-all / restore-all for apps lifecycle + ACP sessions + A2A tasks (local action)
 *
 * Factory:
 *   createProtocolV117Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V117_TOOLS                       (unbound placeholder)
 *
 * State: when the host does not bind its own stores, the factory
 * creates one shared in-memory set (app registry + v8 host + v9
 * lifecycle manager, ACP session manager with the echo runner,
 * A2A card registry + task store) and shares it across the 12
 * tools, so the tools work standalone. The host may override any
 * piece via ProtocolV117ToolOptions.
 *
 * SAFETY: the tools never carry credentials (ACP login markers
 * are only checked for existence; session resume tokens are
 * random UUIDs minted locally, never CLI credentials), never
 * write to disk by themselves (registries and stores are
 * in-memory; the host mirrors snapshots), and never open a
 * network connection (A2A delegation is loopback-only and the
 * loopback guard refuses any other URL before anything is sent).
 */
import type { Tool } from '@open-bot/core';
import {
  McpV8AppHost,
  McpV8AppResourceRegistry,
  McpV9AppLifecycleManager,
  AcpV9SessionManager,
  A2aV9CardRegistry,
  A2aV9TaskStore,
  buildA2aV9AgentCard,
  buildA2aV9WellKnownUrl,
  buildMcpV8AppCsp,
  detectAcpV9CliAgents,
  isA2aV9LoopbackUrl,
  negotiateAllProtocolsV9,
  negotiateProtocolV9Version,
  protocolV9ChangesSinceV8,
  protocolV9DowngradeToV8,
  protocolV9MatrixSummary,
  validateA2aV9AgentCard,
  validateMcpV8AppCallback,
  validateMcpV8AppHtml,
  validateProtocolV9Features,
  MCP_V8_APP_MIME_TYPE,
  PROTOCOL_V9_CURRENT_VERSIONS,
  PROTOCOL_V9_DEFAULT_FEATURES,
  PROTOCOL_V9_VERSION_MATRIX,
  type A2aV9AgentCapabilities,
  type A2aV9AgentCardInput,
  type A2aV9ArtifactKind,
  type A2aV9TaskState,
  type AcpV9KnownAgent,
  type AcpV9PermissionMode,
  type McpV8AppResource,
  type McpV9AppSlot,
  type ProtocolV9Family,
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

export interface ProtocolV117ToolOptions {
  /** App registry accessor (the host binds its registry). */
  getAppRegistry?: () => McpV8AppResourceRegistry | null;
  /** App lifecycle manager accessor (the host binds its manager). */
  getAppLifecycle?: () => McpV9AppLifecycleManager | null;
  /** ACP session manager accessor (the host binds its manager). */
  getAcpSessions?: () => AcpV9SessionManager | null;
  /** A2A card registry accessor (the host binds its registry). */
  getA2aCards?: () => A2aV9CardRegistry | null;
  /** A2A task store accessor (the host binds its store). */
  getA2aTasks?: () => A2aV9TaskStore | null;
}

export function createProtocolV117Tools(opts: ProtocolV117ToolOptions = {}): Tool[] {
  let fallbackApps: McpV8AppResourceRegistry | null = null;
  let fallbackAppHost: McpV8AppHost | null = null;
  let fallbackLifecycle: McpV9AppLifecycleManager | null = null;
  let fallbackAcp: AcpV9SessionManager | null = null;
  let fallbackCards: A2aV9CardRegistry | null = null;
  let fallbackTasks: A2aV9TaskStore | null = null;

  const needApps = (): { registry: McpV8AppResourceRegistry; host: McpV8AppHost; lifecycle: McpV9AppLifecycleManager } => {
    const registry = opts.getAppRegistry?.() ?? fallbackApps ?? (fallbackApps = new McpV8AppResourceRegistry());
    if (!fallbackAppHost) fallbackAppHost = new McpV8AppHost(registry);
    const lifecycle = opts.getAppLifecycle?.() ?? fallbackLifecycle ?? (fallbackLifecycle = new McpV9AppLifecycleManager(registry, fallbackAppHost));
    return { registry, host: fallbackAppHost, lifecycle };
  };
  const needAcp = (): AcpV9SessionManager => {
    return opts.getAcpSessions?.() ?? fallbackAcp ?? (fallbackAcp = new AcpV9SessionManager());
  };
  const needA2a = (): { cards: A2aV9CardRegistry; tasks: A2aV9TaskStore } => {
    const cards = opts.getA2aCards?.() ?? fallbackCards ?? (fallbackCards = new A2aV9CardRegistry());
    const tasks = opts.getA2aTasks?.() ?? fallbackTasks ?? (fallbackTasks = new A2aV9TaskStore());
    return { cards, tasks };
  };

  const versions: Tool = {
    definition: toolDef(
      'protocol_v9_versions',
      'Protocol v9 version matrix (read): current versions per family, changes since v8, downgrade to v8, negotiation for one family / all families, or feature-flag validation (loopback guard must stay on).',
      {
        action: { type: 'string', description: 'matrix | changes | downgrade | negotiate | negotiate-all | features.' },
        family: { type: 'string', description: 'Family for negotiate (a2a, mcp, ucp, acp, gov, agui, a2ui, poppy, nanda).' },
        serverVersions: { type: 'array', description: 'Versions the peer offers (for negotiate).' },
        loopbackOnly: { type: 'boolean', description: 'Value to validate for the loopbackOnly flag (for features).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'matrix':
            return JSON.stringify({ current: PROTOCOL_V9_CURRENT_VERSIONS, matrix: PROTOCOL_V9_VERSION_MATRIX, summary: protocolV9MatrixSummary() }, null, 2);
          case 'changes':
            return JSON.stringify({ changes: protocolV9ChangesSinceV8() }, null, 2);
          case 'downgrade':
            return JSON.stringify({ downgradeToV8: protocolV9DowngradeToV8() }, null, 2);
          case 'negotiate': {
            const family = getStringArg(args, 'family') as ProtocolV9Family;
            const serverVersions = getStringArrayArg(args, 'serverVersions');
            return JSON.stringify({ negotiation: negotiateProtocolV9Version(family, serverVersions) }, null, 2);
          }
          case 'negotiate-all': {
            const offered = args['serverVersions'] === undefined
              ? {}
              : (getRecordArg(args, 'serverVersions') as unknown as Partial<Record<ProtocolV9Family, readonly string[]>>);
            return JSON.stringify({ negotiations: negotiateAllProtocolsV9(offered) }, null, 2);
          }
          case 'features': {
            const loopbackOnly = getOptionalBooleanArg(args, 'loopbackOnly') ?? true;
            const flags = { ...PROTOCOL_V9_DEFAULT_FEATURES, loopbackOnly };
            const problems = validateProtocolV9Features(flags);
            return JSON.stringify({ flags, valid: problems.length === 0, problems }, null, 2);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use matrix | changes | downgrade | negotiate | negotiate-all | features.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const apps: Tool = {
    definition: toolDef(
      'protocol_v9_apps',
      'MCP Apps (local action): register a ui:// resource / render a tool UI into a sandbox descriptor / validate app HTML / build the CSP / check a UI-to-tool call-back. Same v8 host guarantees (sandbox + CSP from declared domains).',
      {
        action: { type: 'string', description: 'register | render | validate | csp | callback-check | list | get.' },
        uri: { type: 'string', description: 'ui:// resource URI (register, render, validate, csp, get).' },
        name: { type: 'string', description: 'App resource name (register).' },
        html: { type: 'string', description: 'App HTML (register, validate).' },
        domains: { type: 'array', description: 'Declared domains (register, validate).' },
        allowedTools: { type: 'array', description: 'Tools the UI may call back into (register).' },
        toolName: { type: 'string', description: 'Tool the UI belongs to (register, render, callback-check).' },
        description: { type: 'string', description: 'App description (register).' },
        tool: { type: 'string', description: 'Tool the UI wants to call (callback-check).' },
        arguments: { type: 'object', description: 'Call-back arguments (callback-check).' },
        preferredWidth: { type: 'number', description: 'Preferred width (register, render).' },
        preferredHeight: { type: 'number', description: 'Preferred height (register, render).' },
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
            const resource: McpV8AppResource = {
              uri: getStringArg(args, 'uri'),
              name: getStringArg(args, 'name'),
              html: getStringArg(args, 'html'),
              mimeType: MCP_V8_APP_MIME_TYPE,
              domains: getStringArrayArg(args, 'domains'),
              allowedTools: getStringArrayArg(args, 'allowedTools'),
              ...(getOptionalStringArg(args, 'description') !== undefined ? { description: getOptionalStringArg(args, 'description') as string } : {}),
              ...(getOptionalStringArg(args, 'toolName') !== undefined ? { toolName: getOptionalStringArg(args, 'toolName') as string } : {}),
            };
            return JSON.stringify({ registration: registry.register(resource) }, null, 2);
          }
          case 'render': {
            const descriptor = host.render({
              toolName: getStringArg(args, 'toolName'),
              resourceUri: getStringArg(args, 'uri'),
              preferredWidth: getOptionalNumberArg(args, 'preferredWidth'),
              preferredHeight: getOptionalNumberArg(args, 'preferredHeight'),
            });
            return JSON.stringify({ descriptor }, null, 2);
          }
          case 'validate': {
            const validation = validateMcpV8AppHtml(
              getStringArg(args, 'html'),
              args['domains'] === undefined ? [] : getStringArrayArg(args, 'domains'),
            );
            return JSON.stringify({ validation }, null, 2);
          }
          case 'csp': {
            const resource = registry.get(getStringArg(args, 'uri'));
            if (resource === undefined) throw new Error(`No app resource "${getStringArg(args, 'uri')}".`);
            return JSON.stringify({ uri: resource.uri, csp: buildMcpV8AppCsp(resource) }, null, 2);
          }
          case 'callback-check': {
            const check = validateMcpV8AppCallback(registry, {
              resourceUri: getStringArg(args, 'uri'),
              tool: getStringArg(args, 'tool'),
              arguments: args['arguments'] === undefined ? {} : getRecordArg(args, 'arguments'),
            });
            return JSON.stringify({ check }, null, 2);
          }
          case 'list':
            return JSON.stringify({ uris: registry.uris(), size: registry.size() }, null, 2);
          case 'get': {
            const resource = registry.get(getStringArg(args, 'uri'));
            if (resource === undefined) throw new Error(`No app resource "${getStringArg(args, 'uri')}".`);
            return JSON.stringify({ resource }, null, 2);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use register | render | validate | csp | callback-check | list | get.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appsLifecycle: Tool = {
    definition: toolDef(
      'protocol_v9_apps_lifecycle',
      'MCP Apps v2 lifecycle (local action): open / close / reopen / suspend / resume / focus / move-slot an app, list apps, counts, events, UI call-back through an instance, snapshot / restore / prune.',
      {
        action: { type: 'string', description: 'open | close | reopen | suspend | resume | focus | move-slot | list | get | counts | events | callback | snapshot | restore | prune.' },
        appId: { type: 'string', description: 'App instance id (close, reopen, suspend, resume, focus, move-slot, get, events, callback).' },
        uri: { type: 'string', description: 'ui:// resource URI (open).' },
        toolName: { type: 'string', description: 'Tool the UI belongs to (open).' },
        slot: { type: 'string', description: 'Panel slot: left | right | bottom | float (open, move-slot).' },
        state: { type: 'string', description: 'Filter by state (list): opening | active | suspended | closed | failed.' },
        reason: { type: 'string', description: 'Why the app stopped (close, suspend).' },
        tool: { type: 'string', description: 'Tool the UI wants to call (callback).' },
        arguments: { type: 'object', description: 'Call-back arguments (callback).' },
        snapshot: { type: 'object', description: 'Manager snapshot to restore (restore).' },
        preferredWidth: { type: 'number', description: 'Preferred width (open).' },
        preferredHeight: { type: 'number', description: 'Preferred height (open).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { lifecycle } = needApps();
        switch (action) {
          case 'open':
            return JSON.stringify({ app: lifecycle.open({
              toolName: getStringArg(args, 'toolName'),
              resourceUri: getStringArg(args, 'uri'),
              ...(getOptionalStringArg(args, 'slot') !== undefined ? { slot: getOptionalStringArg(args, 'slot') as McpV9AppSlot } : {}),
              preferredWidth: getOptionalNumberArg(args, 'preferredWidth'),
              preferredHeight: getOptionalNumberArg(args, 'preferredHeight'),
            }) }, null, 2);
          case 'close':
            return JSON.stringify({ app: lifecycle.close(getStringArg(args, 'appId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'reopen':
            return JSON.stringify({ app: lifecycle.reopen(getStringArg(args, 'appId')) }, null, 2);
          case 'suspend':
            return JSON.stringify({ app: lifecycle.suspend(getStringArg(args, 'appId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'resume':
            return JSON.stringify({ app: lifecycle.resume(getStringArg(args, 'appId')) }, null, 2);
          case 'focus':
            return JSON.stringify({ app: lifecycle.focus(getStringArg(args, 'appId')) }, null, 2);
          case 'move-slot':
            return JSON.stringify({ app: lifecycle.moveSlot(getStringArg(args, 'appId'), getStringArg(args, 'slot') as McpV9AppSlot) }, null, 2);
          case 'list': {
            const state = getOptionalStringArg(args, 'state') as Parameters<typeof lifecycle.list>[0];
            return JSON.stringify({ apps: lifecycle.list(state), count: lifecycle.list(state).length }, null, 2);
          }
          case 'get': {
            const app = lifecycle.get(getStringArg(args, 'appId'));
            if (app === undefined) throw new Error(`No app instance "${getStringArg(args, 'appId')}".`);
            return JSON.stringify({ app }, null, 2);
          }
          case 'counts':
            return JSON.stringify({ counts: lifecycle.counts() }, null, 2);
          case 'events': {
            const appId = getOptionalStringArg(args, 'appId');
            return JSON.stringify({ events: appId === undefined ? lifecycle.getEvents() : lifecycle.eventsFor(appId) }, null, 2);
          }
          case 'callback': {
            const check = lifecycle.callback(
              getStringArg(args, 'appId'),
              getStringArg(args, 'tool'),
              args['arguments'] === undefined ? {} : getRecordArg(args, 'arguments'),
            );
            return JSON.stringify({ check }, null, 2);
          }
          case 'snapshot':
            return JSON.stringify({ snapshot: lifecycle.snapshot() }, null, 2);
          case 'restore': {
            const snap = getRecordArg(args, 'snapshot') as unknown as Parameters<typeof lifecycle.restore>[0];
            return JSON.stringify({ restore: lifecycle.restore(snap) }, null, 2);
          }
          case 'prune':
            return JSON.stringify({ pruned: lifecycle.pruneClosed() }, null, 2);
          default:
            throw new Error('Unknown action "' + action + '". Use open | close | reopen | suspend | resume | focus | move-slot | list | get | counts | events | callback | snapshot | restore | prune.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const acpDetect: Tool = {
    definition: toolDef(
      'protocol_v9_acp_detect',
      'Detect ACP CLI agents on this machine (read): Claude Code / Codex / Gemini CLI — binary on PATH + login-marker presence. Markers are only checked for existence, never read; no credential is copied or sent. Marker presence is a heuristic, not proof of a live login.',
      {
        agent: { type: 'string', description: 'One agent to detect (claude | codex | gemini). Omit for all three.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const agent = getOptionalStringArg(args, 'agent') as AcpV9KnownAgent | undefined;
        const detections = detectAcpV9CliAgents();
        if (agent !== undefined) {
          const found = detections.find((d) => d.agent === agent);
          if (found === undefined) throw new Error(`Unknown ACP agent "${agent}" (known: claude, codex, gemini).`);
          return JSON.stringify({ detection: found }, null, 2);
        }
        return JSON.stringify({
          detections,
          usable: detections.filter((d) => d.usable).map((d) => d.agent),
          usableCount: detections.filter((d) => d.usable).length,
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const acpSessions: Tool = {
    definition: toolDef(
      'protocol_v9_acp_sessions',
      'ACP agent sessions (local action): create / list / get / suspend / resume-suspended / resume (new session carrying the thread) / cancel / complete / set-mode / counts / events / snapshot / restore / prune. Sessions run through the user\'s existing CLI login; open-bot never copies the login.',
      {
        action: { type: 'string', description: 'create | list | get | suspend | resume-suspended | resume | cancel | complete | set-mode | counts | events | snapshot | restore | prune.' },
        sessionId: { type: 'string', description: 'Session id (get, suspend, resume-suspended, resume, cancel, complete, set-mode, events).' },
        agent: { type: 'string', description: 'CLI agent for the session (create): claude | codex | gemini.' },
        cwd: { type: 'string', description: 'Working directory (create).' },
        model: { type: 'string', description: 'Model to ask for (create).' },
        mode: { type: 'string', description: 'Permission mode (create, set-mode): ask | auto | read-only.' },
        allowUnverified: { type: 'boolean', description: 'Create even when the agent was not detected as usable (create).' },
        status: { type: 'string', description: 'Filter by status (list).' },
        reason: { type: 'string', description: 'Why the session stopped (suspend, cancel, complete).' },
        snapshot: { type: 'object', description: 'Manager snapshot to restore (restore).' },
        olderThanMs: { type: 'number', description: 'Prune terminal sessions older than this (prune).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const manager = needAcp();
        switch (action) {
          case 'create':
            return JSON.stringify({ session: manager.create({
              agent: getStringArg(args, 'agent') as AcpV9KnownAgent,
              cwd: getOptionalStringArg(args, 'cwd'),
              model: getOptionalStringArg(args, 'model'),
              mode: getOptionalStringArg(args, 'mode') as AcpV9PermissionMode | undefined,
              allowUnverified: getOptionalBooleanArg(args, 'allowUnverified'),
            }) }, null, 2);
          case 'list': {
            const status = getOptionalStringArg(args, 'status') as Parameters<typeof manager.list>[0];
            return JSON.stringify({ sessions: manager.list(status) }, null, 2);
          }
          case 'get': {
            const session = manager.get(getStringArg(args, 'sessionId'));
            if (session === undefined) throw new Error(`No ACP session "${getStringArg(args, 'sessionId')}".`);
            return JSON.stringify({ session }, null, 2);
          }
          case 'suspend':
            return JSON.stringify({ session: manager.suspend(getStringArg(args, 'sessionId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'resume-suspended':
            return JSON.stringify({ session: manager.resumeSuspended(getStringArg(args, 'sessionId')) }, null, 2);
          case 'resume':
            return JSON.stringify({ session: manager.resumeSession(getStringArg(args, 'sessionId')) }, null, 2);
          case 'cancel':
            return JSON.stringify({ session: manager.cancel(getStringArg(args, 'sessionId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'complete':
            return JSON.stringify({ session: manager.complete(getStringArg(args, 'sessionId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'set-mode':
            return JSON.stringify({ session: manager.setMode(getStringArg(args, 'sessionId'), getStringArg(args, 'mode') as AcpV9PermissionMode) }, null, 2);
          case 'counts':
            return JSON.stringify({ counts: manager.counts() }, null, 2);
          case 'events': {
            const sessionId = getOptionalStringArg(args, 'sessionId');
            return JSON.stringify({ events: sessionId === undefined ? manager.getEvents() : manager.eventsFor(sessionId) }, null, 2);
          }
          case 'snapshot':
            return JSON.stringify({ snapshot: manager.snapshot() }, null, 2);
          case 'restore': {
            const snap = getRecordArg(args, 'snapshot') as unknown as Parameters<typeof manager.restore>[0];
            return JSON.stringify({ restore: manager.restore(snap) }, null, 2);
          }
          case 'prune':
            return JSON.stringify({ pruned: manager.pruneTerminal(getOptionalNumberArg(args, 'olderThanMs')) }, null, 2);
          default:
            throw new Error('Unknown action "' + action + '". Use create | list | get | suspend | resume-suspended | resume | cancel | complete | set-mode | counts | events | snapshot | restore | prune.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const acpPrompt: Tool = {
    definition: toolDef(
      'protocol_v9_acp_prompt',
      'Send a prompt to an ACP session / read its history (local action): the session must be active or idle; the reply comes from the injected runner (echo by default — the host wires the real CLI driver).',
      {
        action: { type: 'string', description: 'send-prompt | history.' },
        sessionId: { type: 'string', description: 'Session id.' },
        prompt: { type: 'string', description: 'Prompt text (send-prompt).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const manager = needAcp();
        const sessionId = getStringArg(args, 'sessionId');
        switch (action) {
          case 'send-prompt': {
            const result = await manager.sendPrompt(sessionId, getStringArg(args, 'prompt'));
            return JSON.stringify({ session: result.session, reply: result.reply }, null, 2);
          }
          case 'history': {
            const session = manager.get(sessionId);
            if (session === undefined) throw new Error(`No ACP session "${sessionId}".`);
            return JSON.stringify({ sessionId, messageCount: session.messages.length, messages: session.messages }, null, 2);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use send-prompt | history.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aCards: Tool = {
    definition: toolDef(
      'protocol_v9_a2a_cards',
      'A2A Agent Cards (local action): build / validate / register / discover by skill, tag or capability / search / list / get / unregister a card, or build its well-known URL. Cards are local-only: the URL must be loopback.',
      {
        action: { type: 'string', description: 'build | validate | register | discover-skill | discover-tag | discover-capability | search | list | get | unregister | well-known.' },
        name: { type: 'string', description: 'Agent name (build, register, get, unregister, well-known).' },
        description: { type: 'string', description: 'What the agent does (build, register).' },
        url: { type: 'string', description: 'Agent base URL, loopback only (build, register, well-known).' },
        version: { type: 'string', description: 'Agent version (build, register).' },
        protocolVersions: { type: 'array', description: 'A2A protocol versions (build, register).' },
        capabilities: { type: 'object', description: 'Capabilities object (build, register).' },
        skills: { type: 'array', description: 'Skills array (build, register).' },
        provider: { type: 'string', description: 'Provider / owner label (build, register).' },
        skillId: { type: 'string', description: 'Skill id (discover-skill).' },
        tag: { type: 'string', description: 'Skill tag (discover-tag).' },
        capability: { type: 'string', description: 'Capability name (discover-capability): streaming | pushNotifications | extendedTask | fileArtifacts.' },
        query: { type: 'string', description: 'Search query (search).' },
        card: { type: 'object', description: 'Full card object (validate, register).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { cards } = needA2a();
        const readCardInput = (): A2aV9AgentCardInput => {
          if (args['card'] !== undefined) {
            const raw = getRecordArg(args, 'card');
            return {
              name: String(raw['name'] ?? ''),
              description: String(raw['description'] ?? ''),
              url: String(raw['url'] ?? ''),
              version: String(raw['version'] ?? ''),
              ...(Array.isArray(raw['protocolVersions']) ? { protocolVersions: raw['protocolVersions'] as string[] } : {}),
              capabilities: (raw['capabilities'] ?? {}) as A2aV9AgentCapabilities,
              skills: (Array.isArray(raw['skills']) ? raw['skills'] : []) as A2aV9AgentCardInput['skills'],
              ...(typeof raw['provider'] === 'string' ? { provider: raw['provider'] } : {}),
            };
          }
          return {
            name: getStringArg(args, 'name'),
            description: getStringArg(args, 'description'),
            url: getStringArg(args, 'url'),
            version: getStringArg(args, 'version'),
            ...(args['protocolVersions'] !== undefined ? { protocolVersions: getStringArrayArg(args, 'protocolVersions') } : {}),
            capabilities: (args['capabilities'] === undefined ? {} : getRecordArg(args, 'capabilities')) as A2aV9AgentCapabilities,
            skills: (args['skills'] === undefined ? [] : (args['skills'] as A2aV9AgentCardInput['skills'])),
            ...(getOptionalStringArg(args, 'provider') !== undefined ? { provider: getOptionalStringArg(args, 'provider') as string } : {}),
          };
        };
        switch (action) {
          case 'build': {
            const card = buildA2aV9AgentCard(readCardInput());
            return JSON.stringify({ card, wellKnownUrl: buildA2aV9WellKnownUrl(card.url) }, null, 2);
          }
          case 'validate': {
            const card = buildA2aV9AgentCard(readCardInput());
            return JSON.stringify({ valid: true, problems: validateA2aV9AgentCard(card), card }, null, 2);
          }
          case 'register': {
            const card = buildA2aV9AgentCard(readCardInput());
            return JSON.stringify({ registered: cards.register(card) }, null, 2);
          }
          case 'discover-skill':
            return JSON.stringify({ cards: cards.discoverBySkill(getStringArg(args, 'skillId')) }, null, 2);
          case 'discover-tag':
            return JSON.stringify({ cards: cards.discoverByTag(getStringArg(args, 'tag')) }, null, 2);
          case 'discover-capability':
            return JSON.stringify({ cards: cards.discoverByCapability(getStringArg(args, 'capability') as keyof A2aV9AgentCapabilities) }, null, 2);
          case 'search':
            return JSON.stringify({ cards: cards.search(getStringArg(args, 'query')) }, null, 2);
          case 'list':
            return JSON.stringify({ cards: cards.list(), names: cards.names(), size: cards.size() }, null, 2);
          case 'get': {
            const found = cards.get(getStringArg(args, 'name'));
            if (found === undefined) throw new Error(`No Agent Card "${getStringArg(args, 'name')}".`);
            return JSON.stringify({ card: found }, null, 2);
          }
          case 'unregister':
            return JSON.stringify({ removed: cards.unregister(getStringArg(args, 'name')) }, null, 2);
          case 'well-known':
            return JSON.stringify({ wellKnownUrl: buildA2aV9WellKnownUrl(getStringArg(args, 'url')) }, null, 2);
          default:
            throw new Error('Unknown action "' + action + '". Use build | validate | register | discover-skill | discover-tag | discover-capability | search | list | get | unregister | well-known.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aTasks: Tool = {
    definition: toolDef(
      'protocol_v9_a2a_tasks',
      'A2A tasks (local action): create / get / list / transition / cancel / complete / request-input / provide-input / counts / events / sweep overdue / prune / snapshot / restore. Same state machine as v7 (terminal states never move).',
      {
        action: { type: 'string', description: 'create | get | list | transition | cancel | complete | request-input | provide-input | counts | events | sweep | prune | snapshot | restore.' },
        taskId: { type: 'string', description: 'Task id.' },
        contextId: { type: 'string', description: 'Conversation context (create).' },
        agentName: { type: 'string', description: 'Agent the task goes to (create).' },
        skillId: { type: 'string', description: 'Skill id the task targets (create).' },
        initialMessage: { type: 'string', description: 'First user message (create).' },
        deadlineMs: { type: 'number', description: 'Deadline timestamp (create).' },
        state: { type: 'string', description: 'State to move to (transition) or filter by (list).' },
        reason: { type: 'string', description: 'Why the task moves / waits (transition, cancel, complete, request-input).' },
        text: { type: 'string', description: 'Input text (provide-input).' },
        snapshot: { type: 'object', description: 'Store snapshot to restore (restore).' },
        nowMs: { type: 'number', description: 'Now timestamp for the overdue sweep (sweep).' },
        olderThanMs: { type: 'number', description: 'Prune terminal tasks older than this (prune).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { tasks } = needA2a();
        switch (action) {
          case 'create':
            return JSON.stringify({ task: tasks.create({
              contextId: getStringArg(args, 'contextId'),
              agentName: getStringArg(args, 'agentName'),
              skillId: getOptionalStringArg(args, 'skillId'),
              initialMessage: getOptionalStringArg(args, 'initialMessage'),
              deadlineMs: getOptionalNumberArg(args, 'deadlineMs'),
            }) }, null, 2);
          case 'get': {
            const task = tasks.get(getStringArg(args, 'taskId'));
            if (task === undefined) throw new Error(`No A2A task "${getStringArg(args, 'taskId')}".`);
            return JSON.stringify({ task }, null, 2);
          }
          case 'list': {
            const state = getOptionalStringArg(args, 'state') as A2aV9TaskState | undefined;
            return JSON.stringify({ tasks: tasks.list(state) }, null, 2);
          }
          case 'transition':
            return JSON.stringify({ task: tasks.transition(getStringArg(args, 'taskId'), getStringArg(args, 'state') as A2aV9TaskState, getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'cancel':
            return JSON.stringify({ task: tasks.cancel(getStringArg(args, 'taskId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'complete':
            return JSON.stringify({ task: tasks.complete(getStringArg(args, 'taskId'), getOptionalStringArg(args, 'reason')) }, null, 2);
          case 'request-input':
            return JSON.stringify({ task: tasks.requestInput(getStringArg(args, 'taskId'), getStringArg(args, 'reason')) }, null, 2);
          case 'provide-input':
            return JSON.stringify({ task: tasks.provideInput(getStringArg(args, 'taskId'), getStringArg(args, 'text')) }, null, 2);
          case 'counts':
            return JSON.stringify({ counts: tasks.counts() }, null, 2);
          case 'events': {
            const taskId = getOptionalStringArg(args, 'taskId');
            return JSON.stringify({ events: taskId === undefined ? tasks.getEvents() : tasks.eventsFor(taskId) }, null, 2);
          }
          case 'sweep':
            return JSON.stringify({ failed: tasks.sweepOverdue(getOptionalNumberArg(args, 'nowMs')) }, null, 2);
          case 'prune':
            return JSON.stringify({ pruned: tasks.pruneTerminal(getOptionalNumberArg(args, 'olderThanMs')) }, null, 2);
          case 'snapshot':
            return JSON.stringify({ snapshot: tasks.snapshot() }, null, 2);
          case 'restore': {
            const snap = getRecordArg(args, 'snapshot') as unknown as Parameters<typeof tasks.restore>[0];
            return JSON.stringify({ restore: tasks.restore(snap) }, null, 2);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use create | get | list | transition | cancel | complete | request-input | provide-input | counts | events | sweep | prune | snapshot | restore.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aMessages: Tool = {
    definition: toolDef(
      'protocol_v9_a2a_messages',
      'A2A message + artifact exchange (local action): send a message on a task / read task history / attach an artifact (text, file, data as JSON, image) / list artifacts. Terminal tasks refuse new messages and artifacts.',
      {
        action: { type: 'string', description: 'send-message | history | add-artifact | list-artifacts.' },
        taskId: { type: 'string', description: 'Task id.' },
        role: { type: 'string', description: 'Message role (send-message): user | agent.' },
        text: { type: 'string', description: 'Message text (send-message).' },
        kind: { type: 'string', description: 'Artifact kind (add-artifact): text | file | data | image.' },
        name: { type: 'string', description: 'Artifact name (add-artifact).' },
        payload: { type: 'string', description: 'Artifact payload (add-artifact; data must be JSON).' },
        mimeType: { type: 'string', description: 'Artifact MIME type (add-artifact).' },
        producedBy: { type: 'string', description: 'Agent that produced the artifact (add-artifact).' },
      },
      ['action', 'taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { tasks } = needA2a();
        const taskId = getStringArg(args, 'taskId');
        switch (action) {
          case 'send-message': {
            const message = tasks.sendMessage(taskId, getStringArg(args, 'role') as 'user' | 'agent', getStringArg(args, 'text'));
            return JSON.stringify({ message }, null, 2);
          }
          case 'history': {
            const task = tasks.get(taskId);
            if (task === undefined) throw new Error(`No A2A task "${taskId}".`);
            return JSON.stringify({ taskId, messageCount: task.history.length, history: task.history }, null, 2);
          }
          case 'add-artifact': {
            const artifact = tasks.addArtifact(taskId, {
              kind: getStringArg(args, 'kind') as A2aV9ArtifactKind,
              name: getStringArg(args, 'name'),
              payload: getStringArg(args, 'payload'),
              mimeType: getOptionalStringArg(args, 'mimeType'),
              producedBy: getStringArg(args, 'producedBy'),
            });
            return JSON.stringify({ artifact }, null, 2);
          }
          case 'list-artifacts':
            return JSON.stringify({ artifacts: tasks.listArtifacts(taskId) }, null, 2);
          default:
            throw new Error('Unknown action "' + action + '". Use send-message | history | add-artifact | list-artifacts.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aDelegate: Tool = {
    definition: toolDef(
      'protocol_v9_a2a_delegate',
      'A2A delegation (local action, loopback-only): delegate a task to the registered agent offering a skill (capability match preferred), list match candidates, check the loopback policy for a URL, or manage push-notification configs (loopback URLs only).',
      {
        action: { type: 'string', description: 'delegate | match | policy | push-add | push-list | push-remove.' },
        contextId: { type: 'string', description: 'Conversation context (delegate).' },
        skillId: { type: 'string', description: 'Skill id to delegate (delegate, match).' },
        initialMessage: { type: 'string', description: 'First user message (delegate).' },
        capability: { type: 'string', description: 'Preferred capability (delegate): streaming | pushNotifications | extendedTask | fileArtifacts.' },
        deadlineMs: { type: 'number', description: 'Deadline timestamp (delegate).' },
        url: { type: 'string', description: 'URL to check / push URL (policy, push-add).' },
        taskId: { type: 'string', description: 'Task id (push-add, push-list).' },
        states: { type: 'array', description: 'States that trigger a push (push-add).' },
        configId: { type: 'string', description: 'Push config id (push-remove).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { cards, tasks } = needA2a();
        switch (action) {
          case 'delegate': {
            const result = tasks.delegate(cards, {
              contextId: getStringArg(args, 'contextId'),
              skillId: getStringArg(args, 'skillId'),
              initialMessage: getOptionalStringArg(args, 'initialMessage'),
              capability: getOptionalStringArg(args, 'capability') as keyof A2aV9AgentCapabilities | undefined,
              deadlineMs: getOptionalNumberArg(args, 'deadlineMs'),
            });
            return JSON.stringify({ task: result.task, agentName: result.agentName, candidates: result.candidates }, null, 2);
          }
          case 'match': {
            const skillId = getStringArg(args, 'skillId');
            const found = cards.discoverBySkill(skillId);
            return JSON.stringify({ skillId, candidates: found.map((c) => c.card.name), cards: found }, null, 2);
          }
          case 'policy': {
            const url = getStringArg(args, 'url');
            return JSON.stringify({ url, loopback: isA2aV9LoopbackUrl(url), allowed: isA2aV9LoopbackUrl(url), policy: 'A2A delegation is local/loopback only; non-loopback URLs are refused.' }, null, 2);
          }
          case 'push-add': {
            const config = tasks.addPushConfig(
              getStringArg(args, 'taskId'),
              getStringArg(args, 'url'),
              args['states'] === undefined ? undefined : getStringArrayArg(args, 'states') as A2aV9TaskState[],
            );
            return JSON.stringify({ pushConfig: config }, null, 2);
          }
          case 'push-list':
            return JSON.stringify({ pushConfigs: tasks.listPushConfigs(getStringArg(args, 'taskId')) }, null, 2);
          case 'push-remove':
            return JSON.stringify({ removed: tasks.removePushConfig(getStringArg(args, 'configId')) }, null, 2);
          default:
            throw new Error('Unknown action "' + action + '". Use delegate | match | policy | push-add | push-list | push-remove.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const registry: Tool = {
    definition: toolDef(
      'protocol_v9_registry',
      'Unified protocols v9 registry (read): counts and listings across MCP Apps (resources + open instances), ACP sessions, A2A cards and A2A tasks, in one call.',
      {
        section: { type: 'string', description: 'One section to list (apps | acp | cards | tasks). Omit for counts of all sections.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const { registry: appRegistry, lifecycle } = needApps();
        const acp = needAcp();
        const { cards, tasks } = needA2a();
        const section = getOptionalStringArg(args, 'section');
        const counts = {
          apps: { resources: appRegistry.size(), instances: lifecycle.counts().total, open: lifecycle.counts().open },
          acpSessions: acp.counts(),
          a2aCards: { size: cards.size(), names: cards.names() },
          a2aTasks: tasks.counts(),
        };
        if (section === undefined) return JSON.stringify({ counts }, null, 2);
        switch (section) {
          case 'apps':
            return JSON.stringify({ counts: counts.apps, resources: appRegistry.uris(), instances: lifecycle.list() }, null, 2);
          case 'acp':
            return JSON.stringify({ counts: counts.acpSessions, sessions: acp.list() }, null, 2);
          case 'cards':
            return JSON.stringify({ counts: counts.a2aCards, cards: cards.list() }, null, 2);
          case 'tasks':
            return JSON.stringify({ counts: counts.a2aTasks, tasks: tasks.list() }, null, 2);
          default:
            throw new Error('Unknown section "' + section + '". Use apps | acp | cards | tasks.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshots: Tool = {
    definition: toolDef(
      'protocol_v9_snapshots',
      'Durable protocols v9 snapshots (local action): save-all returns one combined snapshot (apps lifecycle + ACP sessions + A2A tasks); restore-all restores all three (restored apps/sessions/tasks come back non-running — the host must reopen/resume them).',
      {
        action: { type: 'string', description: 'save-all | restore-all.' },
        snapshot: { type: 'object', description: 'Combined snapshot to restore (restore-all).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const { lifecycle } = needApps();
        const acp = needAcp();
        const { tasks } = needA2a();
        switch (action) {
          case 'save-all':
            return JSON.stringify({
              snapshot: {
                version: 9,
                apps: lifecycle.snapshot(),
                acpSessions: acp.snapshot(),
                a2aTasks: tasks.snapshot(),
              },
            }, null, 2);
          case 'restore-all': {
            const combined = getRecordArg(args, 'snapshot');
            const appsSnap = combined['apps'] as Parameters<typeof lifecycle.restore>[0];
            const acpSnap = combined['acpSessions'] as Parameters<typeof acp.restore>[0];
            const tasksSnap = combined['a2aTasks'] as Parameters<typeof tasks.restore>[0];
            if (combined['version'] !== 9 || appsSnap === undefined || acpSnap === undefined || tasksSnap === undefined) {
              throw new Error('Combined snapshot must have version 9 and apps + acpSessions + a2aTasks sections.');
            }
            return JSON.stringify({
              restore: {
                apps: lifecycle.restore(appsSnap),
                acpSessions: acp.restore(acpSnap),
                a2aTasks: tasks.restore(tasksSnap),
              },
            }, null, 2);
          }
          default:
            throw new Error('Unknown action "' + action + '". Use save-all | restore-all.');
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    versions,
    apps,
    appsLifecycle,
    acpDetect,
    acpSessions,
    acpPrompt,
    a2aCards,
    a2aTasks,
    a2aMessages,
    a2aDelegate,
    registry,
    snapshots,
  ];
}

export const PROTOCOL_V117_TOOLS: Tool[] = createProtocolV117Tools();

export const PROTOCOL_V117_TOOL_NAMES = [
  'protocol_v9_versions',
  'protocol_v9_apps',
  'protocol_v9_apps_lifecycle',
  'protocol_v9_acp_detect',
  'protocol_v9_acp_sessions',
  'protocol_v9_acp_prompt',
  'protocol_v9_a2a_cards',
  'protocol_v9_a2a_tasks',
  'protocol_v9_a2a_messages',
  'protocol_v9_a2a_delegate',
  'protocol_v9_registry',
  'protocol_v9_snapshots',
] as const;

export type ProtocolV117ToolName = (typeof PROTOCOL_V117_TOOL_NAMES)[number];

export function isProtocolV117ToolName(name: string): name is ProtocolV117ToolName {
  return (PROTOCOL_V117_TOOL_NAMES as readonly string[]).includes(name);
}
