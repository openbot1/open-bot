/**
 * Protocols v3 tools for @open-bot/tools (v1.19, Team T3).
 *
 * The agent drives the protocols-v3 stack by tool call:
 *  - protocol_v3_negotiate        — negotiate protocol versions per family, or all families at once (read)
 *  - protocol_v3_stateless_request — build one negotiated stateless request: _meta + headers (read)
 *  - protocol_v3_migration_advisor — readiness report for a legacy server (read)
 *  - protocol_v3_deprecation_check — check one method against the deprecated-feature gate (read)
 *  - protocol_v3_mrtr_answer_validate — validate an MRTR input_required answer against the server schema (read)
 *  - protocol_v3_a2a_frame_validate — validate one A2A v1.1 two-way frame (read)
 *  - protocol_v3_agui_event       — build one AG-UI 1.0 event with an explicit sequence (read)
 *  - protocol_v3_a2ui_render      — render an A2UI v3 surface from a declarative tree (local action)
 *  - protocol_v3_skills_catalog   — list/search the multi-server Skills-over-MCP catalog (read)
 *  - protocol_v3_apps_lifecycle   — install/activate/suspend/resume/uninstall/list an MCP App v3 (local action)
 *  - protocol_v3_apps_permission  — grant/deny/check one MCP App v3 capability (local action, needs approval)
 *
 * Factory:
 *   createProtocolV3Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V3_TOOLS                       (unbound placeholder)
 *
 * SAFETY: the tools never carry credentials (`_meta` and headers are
 * negotiation-only) and never execute skill bodies or app HTML — a
 * skill body is guidance text, an app surface is validated data.
 * The deprecated-feature gate and the permission grants run before
 * any transport is touched. Skill activation still needs the user's
 * approval through the gate (see protocol_v2_skill_approve); these
 * tools only read the catalog. The apps permission tool needs
 * approval because it grants a capability to an app.
 *
 * NOTE (v1.19): exported from the tools package but NOT yet wired
 * into defaultToolFactory — the coordinator wires
 * createProtocolV3Tools and recounts the tool pin, as with the
 * v1.15/v1.16 protocol tools.
 */
import type { Tool } from '@open-bot/core';
import {
  A2uiV3Catalog,
  DeprecatedFeatureGate,
  McpAppsV3Manager,
  SkillsMcpV3Catalog,
  assessStatelessReadiness,
  buildAgUiV3Event,
  buildNegotiatedStatelessRequest,
  isMcpAppV3Capability,
  negotiateAllProtocolsV3,
  negotiateProtocolV3Version,
  validateA2aV3Frame,
  validateMrtrV3Answer,
  type A2uiV3Action,
  type A2uiV3Binding,
  type A2uiV3RenderNode,
  type AppTemplateDeclaration,
  type McpAppV3Capability,
  type McpAppV3SuspendReason,
  type ProtocolAgUiEventData,
  type ProtocolAgUiEventType,
  type ProtocolV3Family,
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

export interface ProtocolV3ToolOptions {
  /** A2UI v3 catalog accessor (the host binds its catalog). */
  getA2uiV3Catalog?: () => A2uiV3Catalog | null;
  /** Skills-over-MCP v3 catalog accessor (the host binds its catalog). */
  getSkillsV3Catalog?: () => SkillsMcpV3Catalog | null;
  /** MCP Apps v3 manager accessor (the host binds its manager). */
  getMcpAppsV3Manager?: () => McpAppsV3Manager | null;
}

export const PROTOCOL_V3_TOOL_NAMES = [
  'protocol_v3_negotiate',
  'protocol_v3_stateless_request',
  'protocol_v3_migration_advisor',
  'protocol_v3_deprecation_check',
  'protocol_v3_mrtr_answer_validate',
  'protocol_v3_a2a_frame_validate',
  'protocol_v3_agui_event',
  'protocol_v3_a2ui_render',
  'protocol_v3_skills_catalog',
  'protocol_v3_apps_lifecycle',
  'protocol_v3_apps_permission',
] as const;

export type ProtocolV3ToolName = (typeof PROTOCOL_V3_TOOL_NAMES)[number];

export function isProtocolV3ToolName(name: string): name is ProtocolV3ToolName {
  return (PROTOCOL_V3_TOOL_NAMES as readonly string[]).includes(name);
}

const PROTOCOL_V3_FAMILY_LIST: readonly string[] = ['mcp', 'a2a', 'agui', 'a2ui'];

const MCP_APP_V3_SUSPEND_REASONS: readonly string[] = [
  'user', 'policy', 'quota', 'permission-revoked', 'error',
];

export function createProtocolV3Tools(opts: ProtocolV3ToolOptions = {}): Tool[] {
  let fallbackA2ui: A2uiV3Catalog | null = null;
  let fallbackSkills: SkillsMcpV3Catalog | null = null;
  let fallbackApps: McpAppsV3Manager | null = null;

  const needA2ui = (): A2uiV3Catalog => opts.getA2uiV3Catalog?.() ?? (fallbackA2ui ??= new A2uiV3Catalog());
  const needSkills = (): SkillsMcpV3Catalog => opts.getSkillsV3Catalog?.() ?? (fallbackSkills ??= new SkillsMcpV3Catalog());
  const needApps = (): McpAppsV3Manager => opts.getMcpAppsV3Manager?.() ?? (fallbackApps ??= new McpAppsV3Manager());

  const negotiate: Tool = {
    definition: toolDef(
      'protocol_v3_negotiate',
      'Negotiate protocol v3 versions (read): one family (mcp, a2a, agui, a2ui) when family is given, or all four families at once. Returns the agreed version per family, its lifecycle status (current / legacy / removed / unknown) and the fallback used when the server lists nothing.',
      {
        family: { type: 'string', description: 'Protocol family: mcp, a2a, agui or a2ui. Omit to negotiate all families.' },
        clientVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the client offers (single-family mode).' },
        serverVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the server supports (single-family mode).' },
        serverVersionsByFamily: { type: 'object', description: 'All-families mode: { mcp: [...], a2a: [...], agui: [...], a2ui: [...] }.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const family = args['family'] === undefined ? undefined : getStringArg(args, 'family');
        if (family !== undefined) {
          if (!PROTOCOL_V3_FAMILY_LIST.includes(family)) {
            throw new Error(`Unknown protocol family "${family}". Use mcp, a2a, agui or a2ui.`);
          }
          const result = negotiateProtocolV3Version(
            family as ProtocolV3Family,
            getStringArrayArg(args, 'clientVersions'),
            getStringArrayArg(args, 'serverVersions'),
          );
          return JSON.stringify({ negotiation: result }, null, 2);
        }
        const byFamily = args['serverVersionsByFamily'] === undefined
          ? {}
          : getRecordArg(args, 'serverVersionsByFamily');
        const serverVersions: Partial<Record<ProtocolV3Family, readonly string[]>> = {};
        for (const key of Object.keys(byFamily)) {
          if (!PROTOCOL_V3_FAMILY_LIST.includes(key)) throw new Error(`Unknown protocol family "${key}".`);
          const value = byFamily[key];
          if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
            throw new Error(`serverVersionsByFamily.${key} must be an array of strings.`);
          }
          serverVersions[key as ProtocolV3Family] = [...(value as string[])];
        }
        return JSON.stringify({ negotiations: negotiateAllProtocolsV3(serverVersions) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const statelessRequest: Tool = {
    definition: toolDef(
      'protocol_v3_stateless_request',
      'Build one negotiated stateless MCP request (read): the _meta envelope plus the MCP-Protocol-Version request header for one JSON-RPC call. Refuses an unknown protocol version and any legacy Mcp-Session-Id header locally, before anything is sent.',
      {
        protocolVersion: { type: 'string', description: 'MCP protocol version, e.g. 2026-07-28 (default 2026-07-28).' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'Extension ids this request needs, e.g. io.modelcontextprotocol/tasks.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const request = buildNegotiatedStatelessRequest({
          protocolVersion: args['protocolVersion'] === undefined ? undefined : getStringArg(args, 'protocolVersion'),
          extensions: args['extensions'] === undefined ? undefined : getStringArrayArg(args, 'extensions'),
        });
        return JSON.stringify({ request }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const migrationAdvisor: Tool = {
    definition: toolDef(
      'protocol_v3_migration_advisor',
      'Assess a legacy server for the stateless migration (read): what already works stateless, what needs the compat shim, what must be replaced (sampling / roots / logging), and the next steps in order. Pure report — no I/O, no server contact.',
      {
        serverName: { type: 'string', description: 'Server name, e.g. legacy-server.' },
        serverVersion: { type: 'string', description: 'Protocol version the server speaks, e.g. 2025-03-26.' },
        capabilities: { type: 'object', description: 'Capabilities the server advertises, as flags: { tools: true, sampling: true, ... }.' },
        discover: { type: 'boolean', description: 'Whether the server answers server/discover (default false).' },
        discoverExtensions: { type: 'array', items: { type: 'string' }, description: 'Extension ids the server lists in server/discover.' },
        discoverVersions: { type: 'array', items: { type: 'string' }, description: 'Protocol versions the server lists in server/discover.' },
      },
      ['serverName', 'serverVersion'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const flags = args['capabilities'] === undefined ? {} : getRecordArg(args, 'capabilities');
        const capabilities: Record<string, unknown> = {};
        for (const area of ['tools', 'resources', 'prompts', 'sampling', 'roots', 'logging']) {
          if (flags[area] === true) capabilities[area] = {};
        }
        const useDiscover = getBooleanArg(args, 'discover', false);
        const serverVersion = getStringArg(args, 'serverVersion');
        const discover = useDiscover
          ? {
              protocolVersion: serverVersion,
              supportedVersions: args['discoverVersions'] === undefined
                ? [serverVersion]
                : getStringArrayArg(args, 'discoverVersions'),
              capabilities: {
                ...(capabilities['tools'] !== undefined ? { tools: {} } : {}),
                ...(capabilities['resources'] !== undefined ? { resources: {} } : {}),
                ...(capabilities['prompts'] !== undefined ? { prompts: {} } : {}),
              },
              serverInfo: { name: getStringArg(args, 'serverName'), version: serverVersion },
              extensions: args['discoverExtensions'] === undefined
                ? []
                : getStringArrayArg(args, 'discoverExtensions'),
            }
          : null;
        const report = assessStatelessReadiness(
          getStringArg(args, 'serverName'),
          serverVersion,
          capabilities as Parameters<typeof assessStatelessReadiness>[2],
          discover as Parameters<typeof assessStatelessReadiness>[3],
        );
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const deprecationCheck: Tool = {
    definition: toolDef(
      'protocol_v3_deprecation_check',
      'Check one MCP method against the deprecated-feature gate (read): Sampling / Roots / Logging are deprecated in MCP 2026-07-28. A call is allowed, allowed with a visible notice (warn), or refused (block) depending on the per-area policy. The gate runs before any transport, so a blocked call never reaches the server.',
      {
        method: { type: 'string', description: 'MCP method, e.g. sampling/createMessage or tools/call.' },
        sampling: { type: 'string', description: 'Policy for sampling: allow, warn or block (default warn).' },
        roots: { type: 'string', description: 'Policy for roots: allow, warn or block (default warn).' },
        logging: { type: 'string', description: 'Policy for logging: allow, warn or block (default warn).' },
      },
      ['method'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const policies: Record<string, string> = {};
        for (const area of ['sampling', 'roots', 'logging'] as const) {
          if (args[area] === undefined) continue;
          const policy = getStringArg(args, area);
          if (policy !== 'allow' && policy !== 'warn' && policy !== 'block') {
            throw new Error(`Policy for ${area} must be allow, warn or block, got "${policy}".`);
          }
          policies[area] = policy;
        }
        const gate = new DeprecatedFeatureGate(policies as ConstructorParameters<typeof DeprecatedFeatureGate>[0]);
        const result = gate.check(getStringArg(args, 'method'));
        return JSON.stringify({ check: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mrtrAnswerValidate: Tool = {
    definition: toolDef(
      'protocol_v3_mrtr_answer_validate',
      'Validate an MRTR input_required answer against the JSON Schema the server sent (read): checks required keys and primitive types (string, number, boolean, object, array, integer). Extra keys are allowed. Returns the problems (empty = valid).',
      {
        answer: { description: 'The answer object the client would send.' },
        schema: { type: 'object', description: 'The server schema: { required: [...], properties: { name: { type: "string" } } }.' },
      },
      ['answer'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const problems = validateMrtrV3Answer(
          args['answer'],
          args['schema'] === undefined ? undefined : getRecordArg(args, 'schema'),
        );
        return JSON.stringify({ problems }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aFrameValidate: Tool = {
    definition: toolDef(
      'protocol_v3_a2a_frame_validate',
      'Validate one A2A v1.1 two-way frame (read): direction (up/down), kind, taskId, non-negative integer sequence and object payload. Unknown extra fields are ignored.',
      {
        frame: { type: 'object', description: 'The frame object to validate.' },
      },
      ['frame'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const result = validateA2aV3Frame(getRecordArg(args, 'frame'));
        return JSON.stringify({ validation: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const aguiEvent: Tool = {
    definition: toolDef(
      'protocol_v3_agui_event',
      'Build one AG-UI 1.0 event with an explicit sequence number (read): validates the type against the AG-UI 1.0 vocabulary and the event shape (runId, sequence, timestamp, data). Refuses unknown types.',
      {
        type: { type: 'string', description: 'AG-UI event type, e.g. TEXT_MESSAGE_CONTENT, TOOL_CALL_START, RUN_FINISHED.' },
        runId: { type: 'string', description: 'Run id.' },
        sequence: { type: 'number', description: 'Non-negative integer sequence number.' },
        data: { type: 'object', description: 'Event data (per-type shape).' },
        stepId: { type: 'string', description: 'Optional step id (subagent runs use their subagent id).' },
      },
      ['type', 'runId', 'sequence', 'data'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sequence = getNumberArg(args, 'sequence');
        if (!Number.isInteger(sequence) || sequence < 0) {
          throw new Error('sequence must be a non-negative integer.');
        }
        const event = buildAgUiV3Event(
          getStringArg(args, 'type') as ProtocolAgUiEventType,
          getStringArg(args, 'runId'),
          sequence,
          getRecordArg(args, 'data') as ProtocolAgUiEventData,
          args['stepId'] === undefined ? undefined : getStringArg(args, 'stepId'),
        );
        return JSON.stringify({ event }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2uiRender: Tool = {
    definition: toolDef(
      'protocol_v3_a2ui_render',
      'Render an A2UI v3 surface from a declarative tree (local action): validates the tree against the catalog (components, layouts, bindings, actions — components are data, never code), resolves data bindings against the run state for the first frame, and returns the surface + its first render frame.',
      {
        surfaceId: { type: 'string', description: 'Surface id (unique per catalog).' },
        runId: { type: 'string', description: 'Run the surface belongs to.' },
        title: { type: 'string', description: 'Surface title.' },
        tree: { type: 'object', description: 'Render tree: { kind: "component" | "stack" | "grid", componentId?, state?, children?, columns? }.' },
        bindings: { type: 'array', items: { type: 'object' }, description: 'Data bindings: [{ prop, path }] (paths into the run state).' },
        actions: { type: 'array', items: { type: 'object' }, description: 'Declarative actions: submit / select / dismiss / open-link (https) / tool-call.' },
        blocking: { type: 'boolean', description: 'Whether the run waits for the user answer.' },
        runState: { type: 'object', description: 'Run state the bindings resolve against.' },
      },
      ['surfaceId', 'runId', 'title', 'tree'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const tree = getRecordArg(args, 'tree') as unknown as A2uiV3RenderNode;
        const bindings = args['bindings'] === undefined
          ? undefined
          : (args['bindings'] as A2uiV3Binding[]);
        const actions = args['actions'] === undefined
          ? undefined
          : (args['actions'] as A2uiV3Action[]);
        if (bindings !== undefined && !Array.isArray(bindings)) throw new Error('bindings must be an array.');
        if (actions !== undefined && !Array.isArray(actions)) throw new Error('actions must be an array.');
        const { surface, frame } = needA2ui().renderSurface({
          surfaceId: getStringArg(args, 'surfaceId'),
          runId: getStringArg(args, 'runId'),
          title: getStringArg(args, 'title'),
          tree,
          bindings,
          actions,
          blocking: args['blocking'] === undefined ? undefined : getBooleanArg(args, 'blocking'),
          runState: args['runState'] === undefined ? undefined : getRecordArg(args, 'runState'),
        });
        return JSON.stringify({ surface, frame }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillsCatalog: Tool = {
    definition: toolDef(
      'protocol_v3_skills_catalog',
      'List / search the multi-server Skills-over-MCP v3 catalog (read): merged skills/list metadata across servers (name, description, version, content hash, owning server, shadowedBy on conflicts). Bodies are NOT returned — a skill body is fetched only after user approval, so unused skills cost no context.',
      {
        query: { type: 'string', description: 'Optional substring filter over name/description.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const catalog = needSkills();
        catalog.discover();
        const query = args['query'] === undefined ? undefined : getStringArg(args, 'query');
        const skills = query === undefined ? catalog.list() : catalog.search(query);
        return JSON.stringify({ count: skills.length, skills }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appsLifecycle: Tool = {
    definition: toolDef(
      'protocol_v3_apps_lifecycle',
      'Manage an MCP App v3 lifecycle (local action): install (needs a template declaration), activate, suspend (needs a reason), resume, uninstall, list installed apps, or get one app record. Suspended apps cannot render; uninstalled apps lose their grants and surfaces.',
      {
        action: { type: 'string', description: 'install, activate, suspend, resume, uninstall, list or get.' },
        appId: { type: 'string', description: 'App id (all actions except list and install).' },
        declaration: { type: 'object', description: 'Template declaration for install: { id, serverName, title, allowedActions? }.' },
        reason: { type: 'string', description: 'Suspend reason: user, policy, quota, permission-revoked or error.' },
        quotas: { type: 'object', description: 'Quotas for install: { maxPrefetchBytes?, maxSurfaces?, maxActionsPerMinute? }.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const manager = needApps();
        if (action === 'list') {
          return JSON.stringify({ apps: manager.list() }, null, 2);
        }
        if (action === 'install') {
          const declaration = getRecordArg(args, 'declaration') as unknown as AppTemplateDeclaration;
          const quotas = args['quotas'] === undefined ? {} : getRecordArg(args, 'quotas');
          const record = manager.install(declaration, quotas as Parameters<typeof manager.install>[1]);
          return JSON.stringify({ record }, null, 2);
        }
        const appId = getStringArg(args, 'appId');
        if (action === 'activate') {
          return JSON.stringify({ record: manager.activate(appId) }, null, 2);
        }
        if (action === 'suspend') {
          const reason = args['reason'] === undefined ? 'user' : getStringArg(args, 'reason');
          if (!MCP_APP_V3_SUSPEND_REASONS.includes(reason)) {
            throw new Error(`Unknown suspend reason "${reason}".`);
          }
          return JSON.stringify({ record: manager.suspend(appId, reason as McpAppV3SuspendReason) }, null, 2);
        }
        if (action === 'resume') {
          return JSON.stringify({ record: manager.resume(appId) }, null, 2);
        }
        if (action === 'uninstall') {
          return JSON.stringify({ record: manager.uninstall(appId) }, null, 2);
        }
        if (action === 'get') {
          return JSON.stringify({ record: manager.get(appId) }, null, 2);
        }
        throw new Error(`Unknown apps lifecycle action "${action}". Use install, activate, suspend, resume, uninstall, list or get.`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appsPermission: Tool = {
    definition: toolDef(
      'protocol_v3_apps_permission',
      'Grant, deny or check one MCP App v3 capability (local action, needs approval): tool-call / link-open / form-submit / resource-read / microphone / camera / clipboard / notifications, for the whole app or one surface. A capability with no grant falls back to the template allowlist, then asks the user (prompt).',
      {
        appId: { type: 'string', description: 'App id.' },
        capability: { type: 'string', description: 'Capability: tool-call, link-open, form-submit, resource-read, microphone, camera, clipboard or notifications.' },
        decision: { type: 'string', description: 'granted, denied or prompt. Omit to only check the current decision.' },
        surfaceId: { type: 'string', description: 'Optional surface the grant applies to.' },
      },
      ['appId', 'capability'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = needApps();
        const appId = getStringArg(args, 'appId');
        const capability = getStringArg(args, 'capability');
        if (!isMcpAppV3Capability(capability)) {
          throw new Error(`Unknown MCP App v3 capability "${capability}".`);
        }
        const surfaceId = args['surfaceId'] === undefined ? undefined : getStringArg(args, 'surfaceId');
        if (args['decision'] === undefined) {
          const check = manager.checkPermission(appId, capability as McpAppV3Capability, surfaceId);
          return JSON.stringify({ check }, null, 2);
        }
        const decision = getStringArg(args, 'decision');
        if (decision !== 'granted' && decision !== 'denied' && decision !== 'prompt') {
          throw new Error('decision must be granted, denied or prompt.');
        }
        const grant = manager.setPermission(
          appId,
          capability as McpAppV3Capability,
          decision as 'granted' | 'denied' | 'prompt',
          surfaceId === undefined ? {} : { surfaceId },
        );
        return JSON.stringify({ grant }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    negotiate,
    statelessRequest,
    migrationAdvisor,
    deprecationCheck,
    mrtrAnswerValidate,
    a2aFrameValidate,
    aguiEvent,
    a2uiRender,
    skillsCatalog,
    appsLifecycle,
    appsPermission,
  ];
}

/** Unbound placeholder tools (names + definitions only, no host bindings). */
export const PROTOCOL_V3_TOOLS: Tool[] = createProtocolV3Tools();
