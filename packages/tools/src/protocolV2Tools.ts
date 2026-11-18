/**
 * Protocols v2 tools for @open-bot/tools (v1.16, Team T2).
 *
 * The agent drives the protocols-v2 stack by tool call:
 *  - protocol_v2_discover    — build a server/discover document (read)
 *  - protocol_v2_negotiate   — negotiate protocol versions per family (read)
 *  - protocol_v2_task_create — submit a long-running MCP task (local action)
 *  - protocol_v2_task_poll   — poll a task + new progress events (read)
 *  - protocol_v2_task_cancel — cancel a task (local action)
 *  - protocol_v2_skill_list  — skills/list metadata (read)
 *  - protocol_v2_skill_get   — skills/get one skill body (read)
 *  - protocol_v2_skill_approve — record the user's approval to activate a skill (local action)
 *  - protocol_v2_a2a_card    — build + sign an A2A Agent Card v2 (read)
 *  - protocol_v2_a2a_verify  — verify a signed A2A Agent Card v2 (read)
 *  - protocol_v2_a2ui_render — render an A2UI surface from the catalog (local action)
 *
 * Factory:
 *   createProtocolV2Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V2_TOOLS                       (unbound placeholder)
 *
 * SAFETY: signing keys come from the host via opts (vault-backed
 * in the app); the tools never log them and never put them in a
 * result. Skill activation needs the user's approval through the
 * gate — this module only records it. Task runners are supplied
 * by the host; a task created without a host runner runs a
 * built-in echo runner (returns its params) so the tools are
 * usable in tests and demos without executing anything else.
 *
 * NOTE (v1.16): exported from the tools package but NOT yet wired
 * into defaultToolFactory — the coordinator wires
 * createProtocolV2Tools and recounts the tool pin, as with the
 * v1.15 protocol tools.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  A2uiV2Catalog,
  McpTaskV2Manager,
  SkillActivationGate,
  SkillsMcpServer,
  buildServerDiscoverDocument,
  generateA2aV2Ed25519KeyPair,
  isA2uiComponentKind,
  negotiateProtocolV2Version,
  signA2aV2AgentCard,
  verifyA2aV2AgentCard,
  type A2aV2SigningKey,
  type A2aV2VerificationKey,
  type A2uiComponentKind,
  type McpTaskV2Runner,
  type ProtocolV2Family,
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

export interface ProtocolV2ToolOptions {
  /** Task manager accessor (the host binds its durable manager). */
  getTaskManager?: () => McpTaskV2Manager | null;
  /** Skills server accessor (the host binds its registered skills). */
  getSkillsServer?: () => SkillsMcpServer | null;
  /** Skill activation gate accessor (the host binds its gate). */
  getSkillGate?: () => SkillActivationGate | null;
  /** A2UI catalog accessor (the host binds its component catalog). */
  getA2uiCatalog?: () => A2uiV2Catalog | null;
  /** Runner used for tasks created through the tools (host-supplied). */
  taskRunner?: McpTaskV2Runner;
  /** HMAC secret for A2A card signing (vault-backed in the app). */
  hmacSecret?: string;
  /** Ed25519 key pair for A2A card signing (generated locally). */
  ed25519KeyPair?: ReturnType<typeof generateA2aV2Ed25519KeyPair>;
}

export const PROTOCOL_V2_TOOL_NAMES = [
  'protocol_v2_discover',
  'protocol_v2_negotiate',
  'protocol_v2_task_create',
  'protocol_v2_task_poll',
  'protocol_v2_task_cancel',
  'protocol_v2_skill_list',
  'protocol_v2_skill_get',
  'protocol_v2_skill_approve',
  'protocol_v2_a2a_card',
  'protocol_v2_a2a_verify',
  'protocol_v2_a2ui_render',
] as const;

export type ProtocolV2ToolName = (typeof PROTOCOL_V2_TOOL_NAMES)[number];

export function isProtocolV2ToolName(name: string): name is ProtocolV2ToolName {
  return (PROTOCOL_V2_TOOL_NAMES as readonly string[]).includes(name);
}

export function createProtocolV2Tools(opts: ProtocolV2ToolOptions = {}): Tool[] {
  let fallbackTasks: McpTaskV2Manager | null = null;
  let fallbackSkills: SkillsMcpServer | null = null;
  let fallbackGate: SkillActivationGate | null = null;
  let fallbackCatalog: A2uiV2Catalog | null = null;

  const needTasks = (): McpTaskV2Manager => {
    const manager = opts.getTaskManager?.() ?? fallbackTasks;
    if (manager) return manager;
    // In-memory fallback (no snapshot path): tasks live for the
    // process only. The host binds a durable manager in the app.
    fallbackTasks = new McpTaskV2Manager({
      snapshotPath: path.join(os.tmpdir(), `open-bot-protocol-v2-tasks-${process.pid}.json`),
    });
    return fallbackTasks;
  };
  const needSkills = (): SkillsMcpServer => opts.getSkillsServer?.() ?? (fallbackSkills ??= new SkillsMcpServer());
  const needGate = (): SkillActivationGate => opts.getSkillGate?.() ?? (fallbackGate ??= new SkillActivationGate());
  const needCatalog = (): A2uiV2Catalog => opts.getA2uiCatalog?.() ?? (fallbackCatalog ??= new A2uiV2Catalog());
  const echoRunner: McpTaskV2Runner = async (ctx) => {
    ctx.reportProgress(1, 'done');
    return { echo: true, taskId: ctx.taskId, attempt: ctx.attempt };
  };

  const discover: Tool = {
    definition: toolDef(
      'protocol_v2_discover',
      'Build the MCP 2026-07-28 server/discover document for this server (read): protocol version, server info, capability matrix, extensions (Tasks, Skills, Apps) and the legacy deprecation notice. No session id is ever issued.',
      {
        serverName: { type: 'string', description: 'Server name, e.g. open-bot.' },
        serverVersion: { type: 'string', description: 'Server version, e.g. 1.16.0.' },
        clientVersions: { type: 'array', items: { type: 'string' }, description: 'Optional client MCP versions to negotiate against.' },
      },
      ['serverName', 'serverVersion'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const { document, negotiation } = buildServerDiscoverDocument({
          serverName: getStringArg(args, 'serverName'),
          serverVersion: getStringArg(args, 'serverVersion'),
          clientVersions: args['clientVersions'] === undefined ? undefined : getStringArrayArg(args, 'clientVersions'),
        });
        return JSON.stringify({ document, negotiation }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const negotiate: Tool = {
    definition: toolDef(
      'protocol_v2_negotiate',
      'Negotiate a protocol version (read): returns the highest version both sides support for one family (mcp, a2a, agui, a2ui), whether it is legacy, and fallback guidance when nothing matches.',
      {
        family: { type: 'string', description: 'Protocol family: mcp, a2a, agui or a2ui.' },
        clientVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the client offers.' },
        serverVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the server supports.' },
      },
      ['family', 'clientVersions', 'serverVersions'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const family = getStringArg(args, 'family');
        if (family !== 'mcp' && family !== 'a2a' && family !== 'agui' && family !== 'a2ui') {
          throw new Error(`Unknown protocol family "${family}". Use mcp, a2a, agui or a2ui.`);
        }
        const result = negotiateProtocolV2Version(
          family as ProtocolV2Family,
          getStringArrayArg(args, 'clientVersions'),
          getStringArrayArg(args, 'serverVersions'),
        );
        return JSON.stringify({ negotiation: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskCreate: Tool = {
    definition: toolDef(
      'protocol_v2_task_create',
      'Submit a long-running MCP task (local action): creates a durable task id, runs the host runner in the background with the retry policy, and returns the id to poll with protocol_v2_task_poll. The task survives reconnects; the id is durable.',
      {
        method: { type: 'string', description: 'Task method, e.g. tools/call.' },
        params: { type: 'object', description: 'Task parameters.' },
        maxAttempts: { type: 'number', description: 'Maximum attempts including the first (default 1).' },
        tenantId: { type: 'string', description: 'Optional tenant the task belongs to.' },
      },
      ['method'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needTasks();
        const maxAttempts = args['maxAttempts'] === undefined ? undefined : args['maxAttempts'];
        if (maxAttempts !== undefined && (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1)) {
          throw new Error('maxAttempts must be a positive integer.');
        }
        const record = manager.submit(
          {
            method: getStringArg(args, 'method'),
            params: args['params'] === undefined ? {} : getRecordArg(args, 'params'),
            retryPolicy: maxAttempts === undefined ? undefined : { maxAttempts },
            tenantId: args['tenantId'] === undefined ? undefined : getStringArg(args, 'tenantId'),
          },
          opts.taskRunner ?? echoRunner,
        );
        return JSON.stringify({ taskId: record.taskId, state: record.state, method: record.method }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskPoll: Tool = {
    definition: toolDef(
      'protocol_v2_task_poll',
      'Poll a durable MCP task (read): returns the current state plus only the progress events after afterSequence, so a reconnecting client replays exactly what it missed.',
      {
        taskId: { type: 'string', description: 'Durable task id from protocol_v2_task_create.' },
        afterSequence: { type: 'number', description: 'Only progress events after this sequence (default -1 = all).' },
      },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const after = args['afterSequence'] === undefined ? -1 : args['afterSequence'];
        if (typeof after !== 'number' || !Number.isInteger(after)) throw new Error('afterSequence must be an integer.');
        const { record, newProgress } = needTasks().poll(getStringArg(args, 'taskId'), after);
        return JSON.stringify({ record, newProgress }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskCancel: Tool = {
    definition: toolDef(
      'protocol_v2_task_cancel',
      'Cancel a durable MCP task (local action): a running or created task becomes cancelled; terminal tasks cannot be cancelled.',
      { taskId: { type: 'string', description: 'Durable task id.' } },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const record = needTasks().cancel(getStringArg(args, 'taskId'));
        return JSON.stringify({ taskId: record.taskId, state: record.state }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillList: Tool = {
    definition: toolDef(
      'protocol_v2_skill_list',
      'List MCP skills (SEP-2640) (read): metadata only (name, description, version, content hash, skill:// uri) — bodies are fetched with protocol_v2_skill_get, so unused skills cost no context.',
      {
        query: { type: 'string', description: 'Optional substring filter over name/description.' },
        source: { type: 'string', description: 'Optional source filter: builtin or user.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const source = args['source'] === undefined ? undefined : getStringArg(args, 'source');
        if (source !== undefined && source !== 'builtin' && source !== 'user') {
          throw new Error('source must be "builtin" or "user".');
        }
        const skills = needSkills().list({
          source: source as 'builtin' | 'user' | undefined,
          query: args['query'] === undefined ? undefined : getStringArg(args, 'query'),
        });
        return JSON.stringify({ count: skills.length, skills }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillGet: Tool = {
    definition: toolDef(
      'protocol_v2_skill_get',
      'Get one MCP skill (SEP-2640) (read): returns the parsed SKILL.md body after re-verifying the content hash. The body is guidance text, never code — it is not executed. Activation still needs the user approval recorded with protocol_v2_skill_approve.',
      { name: { type: 'string', description: 'Skill name, e.g. code-review.' } },
      ['name'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const skill = needSkills().get(getStringArg(args, 'name'));
        return JSON.stringify({ skill }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const skillApprove: Tool = {
    definition: toolDef(
      'protocol_v2_skill_approve',
      'Record the user approval to activate a skill (local action): allow-once, allow-always or deny. The approval is bound to the skill content hash — editing the skill re-asks. The tool records the decision; the user makes it (approval card / Settings).',
      {
        name: { type: 'string', description: 'Skill name.' },
        decision: { type: 'string', description: 'allow-once, allow-always or deny.' },
      },
      ['name', 'decision'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const decision = getStringArg(args, 'decision');
        if (decision !== 'allow-once' && decision !== 'allow-always' && decision !== 'deny') {
          throw new Error('decision must be allow-once, allow-always or deny.');
        }
        const skill = needSkills().get(name);
        const approval = needGate().approve(name, skill.contentHash, decision);
        return JSON.stringify({ approval }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aCard: Tool = {
    definition: toolDef(
      'protocol_v2_a2a_card',
      'Build + sign an A2A Agent Card v2 (read): HMAC-SHA256 with the host secret, or Ed25519 with a locally generated key pair. The signature covers the full card (including tenant + expiry). Refuses without a signing key.',
      {
        name: { type: 'string', description: 'Agent name.' },
        description: { type: 'string', description: 'Agent description.' },
        url: { type: 'string', description: 'Agent URL.' },
        version: { type: 'string', description: 'Agent version.' },
        protocolVersions: { type: 'array', items: { type: 'string' }, description: 'A2A versions the agent speaks, e.g. ["1.0.0"].' },
        algorithm: { type: 'string', description: 'hmac-sha256 or ed25519 (default hmac-sha256).' },
        tenantId: { type: 'string', description: 'Tenant that owns this agent (default "default").' },
      },
      ['name', 'description', 'url', 'version', 'protocolVersions'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const algorithm = args['algorithm'] === undefined ? 'hmac-sha256' : getStringArg(args, 'algorithm');
        let key: A2aV2SigningKey;
        if (algorithm === 'hmac-sha256') {
          if (!opts.hmacSecret) throw new Error('No HMAC key configured for A2A card signing (host must supply one).');
          key = { algorithm: 'hmac-sha256', secret: opts.hmacSecret, keyId: 'host-hmac' };
        } else if (algorithm === 'ed25519') {
          const keyPair = opts.ed25519KeyPair ?? generateA2aV2Ed25519KeyPair();
          key = { algorithm: 'ed25519', keyPair };
        } else {
          throw new Error(`Unknown signature algorithm "${algorithm}". Use hmac-sha256 or ed25519.`);
        }
        const card = signA2aV2AgentCard(
          {
            name: getStringArg(args, 'name'),
            description: getStringArg(args, 'description'),
            url: getStringArg(args, 'url'),
            version: getStringArg(args, 'version'),
            protocolVersions: getStringArrayArg(args, 'protocolVersions'),
            tenantId: args['tenantId'] === undefined ? undefined : getStringArg(args, 'tenantId'),
          },
          key,
        );
        return JSON.stringify({ card }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aVerify: Tool = {
    definition: toolDef(
      'protocol_v2_a2a_verify',
      'Verify a signed A2A Agent Card v2 (read): checks structure, expiry, tenant scope, negotiated version and the signature (HMAC with the host secret, Ed25519 with the public key in the card). Returns valid + reasons.',
      {
        card: { type: 'object', description: 'The signed card object.' },
        expectedTenantId: { type: 'string', description: 'Optional tenant the card must belong to.' },
      },
      ['card'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const card = getRecordArg(args, 'card');
        const signature = card['signature'] as Record<string, unknown> | undefined;
        if (typeof signature !== 'object' || signature === null) throw new Error('card.signature is required.');
        let key: A2aV2VerificationKey;
        if (signature['algorithm'] === 'hmac-sha256') {
          if (!opts.hmacSecret) throw new Error('No HMAC key configured to verify this card (host must supply one).');
          key = { algorithm: 'hmac-sha256', secret: opts.hmacSecret };
        } else if (signature['algorithm'] === 'ed25519') {
          key = { algorithm: 'ed25519', publicKeySpkiBase64url: typeof signature['publicKey'] === 'string' ? signature['publicKey'] : undefined };
        } else {
          throw new Error(`Unknown signature algorithm "${String(signature['algorithm'])}".`);
        }
        const result = verifyA2aV2AgentCard(card, key, {
          expectedTenantId: args['expectedTenantId'] === undefined ? undefined : getStringArg(args, 'expectedTenantId'),
        });
        return JSON.stringify({ verification: result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2uiRender: Tool = {
    definition: toolDef(
      'protocol_v2_a2ui_render',
      'Render an A2UI generative surface from the component catalog (local action): validates the spec and the declarative state against the component props, negotiates against the client capabilities (falling back when needed), and returns the render frame.',
      {
        componentId: { type: 'string', description: 'Catalog component id, e.g. generic-form.' },
        kind: { type: 'string', description: 'Component kind: card, form, table, chart, approval, options, message, progress, list or detail.' },
        runId: { type: 'string', description: 'Run the surface belongs to.' },
        title: { type: 'string', description: 'Surface title.' },
        state: { type: 'object', description: 'Declarative state (props for the component).' },
        blocking: { type: 'boolean', description: 'Whether the run waits for the user answer.' },
      },
      ['componentId', 'kind', 'runId', 'title', 'state'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const catalog = needCatalog();
        const kind = getStringArg(args, 'kind');
        if (!isA2uiComponentKind(kind)) throw new Error(`Unknown A2UI component kind "${kind}".`);
        const frame = catalog.renderSurface(
          {
            componentId: getStringArg(args, 'componentId'),
            kind: kind as A2uiComponentKind,
            runId: getStringArg(args, 'runId'),
            title: getStringArg(args, 'title'),
            data: { text: getStringArg(args, 'title') },
            blocking: args['blocking'] === undefined ? undefined : args['blocking'] as boolean,
          },
          getRecordArg(args, 'state'),
        );
        return JSON.stringify({ frame }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [discover, negotiate, taskCreate, taskPoll, taskCancel, skillList, skillGet, skillApprove, a2aCard, a2aVerify, a2uiRender];
}

/** Unbound placeholder tools (names + definitions only, no host bindings). */
export const PROTOCOL_V2_TOOLS: Tool[] = createProtocolV2Tools();
